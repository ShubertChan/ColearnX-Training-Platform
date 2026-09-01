import { closeDatabase, query, withTransaction } from '../db/database.js';
import { deleteStoredObject } from './r2.js';

type CleanupAsset = {
  storage_asset_id: string;
  bucket_name: string;
  object_key: string;
};

const batchSize = 100;
const maxBatchesPerRun = 10;

async function lockCleanupCandidates() {
  return withTransaction(async (client) => {
    await client.query(`WITH expired AS (
      SELECT storage_asset_id FROM storage_assets
      WHERE asset_status IN ('pending', 'uploaded') AND upload_expires_at < now()
      ORDER BY upload_expires_at, storage_asset_id
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    )
    UPDATE storage_assets sa
    SET asset_status = 'orphaned', updated_at = now()
    FROM expired
    WHERE sa.storage_asset_id = expired.storage_asset_id`, [batchSize]);

    const candidates = await client.query<CleanupAsset>(`SELECT sa.storage_asset_id, sa.bucket_name, sa.object_key
      FROM storage_assets sa
      WHERE sa.asset_status IN ('orphaned', 'delete_pending')
        AND NOT EXISTS (
          SELECT 1 FROM content_versions cv WHERE cv.storage_asset_id = sa.storage_asset_id
        )
      ORDER BY sa.updated_at, sa.storage_asset_id
      FOR UPDATE SKIP LOCKED
      LIMIT $1`, [batchSize]);
    return candidates.rows;
  });
}

async function reconcile() {
  let removed = 0;
  let deferred = 0;
  for (let batch = 0; batch < maxBatchesPerRun; batch += 1) {
    const candidates = await lockCleanupCandidates();
    if (!candidates.length) break;
    for (const asset of candidates) {
      try {
        await deleteStoredObject({ bucketName: asset.bucket_name, objectKey: asset.object_key });
        await query(`UPDATE storage_assets
          SET asset_status = 'deleted', deleted_at = now(), updated_at = now()
          WHERE storage_asset_id = $1 AND asset_status IN ('orphaned', 'delete_pending')`, [asset.storage_asset_id]);
        removed += 1;
      } catch {
        // Preserve the state for a later controlled retry; never revive it.
        deferred += 1;
      }
    }
    if (candidates.length < batchSize) break;
  }
  process.stdout.write(`R2 reconciliation complete: removed=${removed} deferred=${deferred}\n`);
}

reconcile().catch((error) => {
  process.stderr.write(`R2 reconciliation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}).finally(closeDatabase);
