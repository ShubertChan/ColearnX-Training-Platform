import type { PoolClient } from 'pg';
import { canFinalizeStorageAssetDeletion, SIGNED_UPLOAD_EXPIRY_SAFETY_SECONDS } from './storage-deletion.js';

export type CleanupKind = 'content' | 'course';
export type CleanupAsset = {
  asset_id: string;
  bucket_name: string;
  object_key: string;
  asset_status: string;
  upload_expires_at: Date | string;
  parent_status: string;
  version_status: string;
  has_reference: boolean;
  has_direct_reference: boolean;
};

type CleanupDependencies = {
  withTransaction: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
  deleteObject: (asset: { bucketName: string; objectKey: string }) => Promise<unknown>;
  now?: () => Date;
};

const definitions = {
  content: {
    table: 'storage_assets', id: 'storage_asset_id',
    joins: 'JOIN content_versions cv ON cv.content_version_id = sa.content_version_id JOIN contents c ON c.content_id = cv.content_id',
    parentStatus: 'c.publication_status', versionStatus: 'cv.version_status', retiredStatus: 'retired', parentLocks: 'cv, c',
    directReferences: 'EXISTS (SELECT 1 FROM content_versions primary_file WHERE primary_file.storage_asset_id = sa.storage_asset_id)',
    references: `(EXISTS (SELECT 1 FROM content_versions primary_file WHERE primary_file.storage_asset_id = sa.storage_asset_id)
      OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.content_version_id = sa.content_version_id)
      OR EXISTS (SELECT 1 FROM content_access_grants cag WHERE cag.content_version_id = sa.content_version_id))`,
  },
  course: {
    table: 'course_delivery_assets', id: 'course_delivery_asset_id',
    joins: 'JOIN course_runs cr ON cr.course_run_id = sa.course_run_id JOIN courses c ON c.course_id = cr.course_id',
    parentStatus: 'c.publication_status', versionStatus: 'cr.run_status', retiredStatus: 'archived', parentLocks: 'cr, c',
    // Course delivery snapshots contain coordination text, not asset IDs. Buyer delivery
    // only exposes ready assets; an explicit draft-deletion tombstone is never deliverable.
    directReferences: 'false',
    references: `(EXISTS (SELECT 1 FROM order_items oi WHERE oi.course_run_id = sa.course_run_id)
      OR EXISTS (SELECT 1 FROM course_enrolments ce WHERE ce.course_run_id = sa.course_run_id))`,
  },
} as const;

function selection(kind: CleanupKind) {
  const d = definitions[kind];
  return `SELECT sa.${d.id} AS asset_id, sa.bucket_name, sa.object_key, sa.asset_status, sa.upload_expires_at,
    ${d.parentStatus} AS parent_status, ${d.versionStatus} AS version_status, ${d.references} AS has_reference,
    ${d.directReferences} AS has_direct_reference
    FROM ${d.table} sa ${d.joins}`;
}

export function cleanupCandidateSql(kind: CleanupKind) {
  const d = definitions[kind];
  return `/* cleanup:list:${kind} */ ${selection(kind)}
    WHERE NOT (sa.${d.id} = ANY($1::uuid[]))
      AND sa.upload_expires_at + (${SIGNED_UPLOAD_EXPIRY_SAFETY_SECONDS} * interval '1 second') <= now()
      AND NOT (${d.directReferences})
      AND (sa.asset_status = 'delete_pending'
        OR (${d.parentStatus} IN ('draft', 'archived') AND ${d.versionStatus} IN ('draft', '${d.retiredStatus}')
          AND NOT ${d.references}
          AND (sa.asset_status IN ('pending', 'uploaded', 'orphaned')
            OR (sa.asset_status IN ('ready', 'quarantined') AND ${d.parentStatus} = 'archived' AND ${d.versionStatus} = '${d.retiredStatus}'))))
    ORDER BY sa.updated_at ASC, sa.${d.id} ASC LIMIT $2`;
}

export function cleanupAssetEligible(kind: CleanupKind, asset: CleanupAsset, now = new Date()) {
  const retiredStatus = definitions[kind].retiredStatus;
  if (!canFinalizeStorageAssetDeletion(asset.upload_expires_at, now) || asset.has_direct_reference) return false;
  // An attachment can be removed while its PUT URL is still usable and the remaining
  // files published before maintenance runs. Such tombstones must not leak forever.
  if (asset.asset_status === 'delete_pending') return true;
  if (asset.has_reference) return false;
  if (!['draft', 'archived'].includes(asset.parent_status) || !['draft', retiredStatus].includes(asset.version_status)) return false;
  if (['pending', 'uploaded', 'orphaned'].includes(asset.asset_status)) return true;
  // A deleted draft can leave verified files behind. Never collect ready files from an active draft.
  return ['ready', 'quarantined'].includes(asset.asset_status)
    && asset.parent_status === 'archived' && asset.version_status === retiredStatus;
}

export async function reconcileStorage(dependencies: CleanupDependencies, options: { batchSize?: number; maxBatches?: number } = {}) {
  const batchSize = options.batchSize ?? 100;
  const maxBatches = options.maxBatches ?? 10;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100
    || !Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 10) throw new Error('Invalid cleanup batch limits.');
  const now = dependencies.now ?? (() => new Date());
  const result = { removed: 0, deferred: 0, skipped: 0 };
  for (const kind of ['content', 'course'] as const) {
    const d = definitions[kind];
    const seen = new Set<string>();
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const candidates = await dependencies.withTransaction(async (client) => {
        const rows = await client.query<CleanupAsset>(cleanupCandidateSql(kind), [[...seen], batchSize]);
        return rows.rows;
      });
      if (!candidates.length) break;
      for (const candidate of candidates) {
        if (seen.has(candidate.asset_id)) continue;
        seen.add(candidate.asset_id);
        const outcome = await dependencies.withTransaction(async (client) => {
          // Match authoring's parent/version -> asset lock order. Skip contended parents
          // without holding an asset row that a concurrent upload is trying to update.
          const parent = await client.query(`/* cleanup:parent:${kind} */ SELECT sa.${d.id}
            FROM ${d.table} sa ${d.joins} WHERE sa.${d.id} = $1
            FOR UPDATE OF ${d.parentLocks} SKIP LOCKED`, [candidate.asset_id]);
          if (!parent.rows.length) return 'skipped' as const;
          // Recheck under locks held THROUGH R2 deletion. Another worker skips the locked asset;
          // authoring/moderation cannot publish or replace it between validation and deletion.
          const locked = await client.query<CleanupAsset>(`/* cleanup:lock:${kind} */ ${selection(kind)}
            WHERE sa.${d.id} = $1 FOR UPDATE OF sa SKIP LOCKED`, [candidate.asset_id]);
          const asset = locked.rows[0];
          if (!asset || !cleanupAssetEligible(kind, asset, now())) return 'skipped' as const;
          try {
            await dependencies.deleteObject({ bucketName: asset.bucket_name, objectKey: asset.object_key });
          } catch {
            // Commit retryable state, move it behind older candidates, and don't retry this row
            // again in this invocation. A permanently failing file cannot starve every newer one.
            await client.query(`/* cleanup:deferred:${kind} */ UPDATE ${d.table}
              SET asset_status = 'delete_pending', updated_at = now() WHERE ${d.id} = $1`, [asset.asset_id]);
            return 'deferred' as const;
          }
          await client.query(`/* cleanup:deleted:${kind} */ UPDATE ${d.table}
            SET asset_status = 'deleted', deleted_at = now(), updated_at = now() WHERE ${d.id} = $1`, [asset.asset_id]);
          return 'removed' as const;
        });
        result[outcome] += 1;
      }
      if (candidates.length < batchSize) break;
    }
  }
  return result;
}
