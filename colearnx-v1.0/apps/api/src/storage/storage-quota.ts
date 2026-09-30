import type { PoolClient } from 'pg';
import { ApiError } from '../lib/http.js';
import { canFinalizeStorageAssetDeletion, SIGNED_UPLOAD_EXPIRY_SAFETY_SECONDS } from './storage-deletion.js';

type QuotaRecoveryDependencies = {
  findObject?: (locator: { bucketName: string; objectKey: string }) => Promise<unknown | null>;
};

async function releaseAbsentExpiredUploads(client: Pick<PoolClient, 'query'>, ownerUserId: string,
  dependencies: QuotaRecoveryDependencies) {
  for (const [table, id] of [['storage_assets', 'storage_asset_id'], ['course_delivery_assets', 'course_delivery_asset_id']] as const) {
    // Never release verified files, multipart video sources, or bytes while a
    // signed PUT can still recreate them. Hold the row lock through the R2 check.
    const candidates = await client.query<{ asset_id: string; bucket_name: string; object_key: string; upload_expires_at: Date }>(
      `/* quota:expired:${table} */ SELECT ${id} AS asset_id, bucket_name, object_key, upload_expires_at
       FROM ${table}
       WHERE owner_user_id = $1 AND asset_status IN ('pending', 'uploaded', 'orphaned', 'delete_pending')
         AND verified_byte_size IS NULL
         AND upload_expires_at <= now() - (${SIGNED_UPLOAD_EXPIRY_SAFETY_SECONDS} * interval '1 second')
         ${table === 'course_delivery_assets' ? "AND asset_purpose = 'cloud_download'" : `AND NOT EXISTS (
           SELECT 1 FROM content_versions cv WHERE cv.storage_asset_id = ${table}.${id})`}
       ORDER BY upload_expires_at, ${id} LIMIT 10 FOR UPDATE SKIP LOCKED`, [ownerUserId]);
    if (!candidates.rows.length) continue;
    const findObject = dependencies.findObject ?? (await import('./r2.js')).findStoredObject;
    for (const asset of candidates.rows) {
      if (!canFinalizeStorageAssetDeletion(asset.upload_expires_at)) continue;
      let stored: unknown;
      try { stored = await findObject({ bucketName: asset.bucket_name, objectKey: asset.object_key }); }
      catch { continue; } // A storage/network error is not evidence of absence.
      if (stored !== null) continue;
      await client.query(`/* quota:release:${table} */ UPDATE ${table}
        SET asset_status = 'deleted', deleted_at = now(), updated_at = now()
        WHERE ${id} = $1 AND owner_user_id = $2`, [asset.asset_id, ownerUserId]);
    }
  }
}

export type StorageQuotaInput = {
  usedBytes: number;
  pendingUploads: number;
  requestedBytes: number;
  maxBytes: number;
  maxPendingUploads: number;
};

export type StorageQuotaViolation = {
  status: 413 | 429;
  code: 'CONTENT_STORAGE_QUOTA_EXCEEDED' | 'CONTENT_UPLOAD_PENDING_LIMIT';
  message: string;
};

export function storageQuotaViolation(input: StorageQuotaInput): StorageQuotaViolation | null {
  if (input.pendingUploads >= input.maxPendingUploads) {
    return {
      status: 429,
      code: 'CONTENT_UPLOAD_PENDING_LIMIT',
      message: 'Finish or remove an existing upload before starting another one.',
    };
  }
  if (input.usedBytes + input.requestedBytes > input.maxBytes) {
    return {
      status: 413,
      code: 'CONTENT_STORAGE_QUOTA_EXCEEDED',
      message: 'Your storage limit has been reached. Remove an existing file or choose a smaller file.',
    };
  }
  return null;
}

export async function lockStorageAccount(client: Pick<PoolClient, 'query'>, ownerUserId: string) {
  // Both Creator and Trainer use the same transaction-scoped account lock.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ownerUserId]);
}

export async function assertAccountStorageQuota(client: Pick<PoolClient, 'query'>, ownerUserId: string,
  requestedBytes: number, limits: Pick<StorageQuotaInput, 'maxBytes' | 'maxPendingUploads'>,
  dependencies: QuotaRecoveryDependencies = {}) {
  await lockStorageAccount(client, ownerUserId);
  const readUsage = () => client.query<{ used_bytes: string; pending_uploads: string }>(`SELECT
    COALESCE(sum(GREATEST(declared_byte_size, COALESCE(verified_byte_size, declared_byte_size))), 0)::text AS used_bytes,
    count(*) FILTER (WHERE asset_status IN ('pending', 'uploaded') AND upload_expires_at > now())::text AS pending_uploads
    FROM (
      SELECT declared_byte_size, verified_byte_size, asset_status, upload_expires_at
      FROM storage_assets WHERE owner_user_id = $1 AND asset_status <> 'deleted'
      UNION ALL
      SELECT declared_byte_size, verified_byte_size, asset_status, upload_expires_at
      FROM course_delivery_assets WHERE owner_user_id = $1 AND asset_status <> 'deleted'
    ) account_assets`, [ownerUserId]);
  const check = (current: { used_bytes: string; pending_uploads: string }) => storageQuotaViolation({ ...limits, requestedBytes,
    usedBytes: Number(current.used_bytes), pendingUploads: Number(current.pending_uploads) });
  let violation = check((await readUsage()).rows[0]);
  if (violation?.code === 'CONTENT_STORAGE_QUOTA_EXCEEDED') {
    await releaseAbsentExpiredUploads(client, ownerUserId, dependencies);
    violation = check((await readUsage()).rows[0]);
  }
  if (violation) throw new ApiError(violation.status, violation.code, violation.message);
}
