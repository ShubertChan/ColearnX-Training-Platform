import { Pool } from 'pg';
import { env } from '../config/env.js';
import { closeDatabase } from '../db/database.js';
import { closeRedis } from '../lib/redis.js';
import { findStoredObject, readStoredObject, streamStoredObject } from '../storage/r2.js';
import { drainSecurityAlerts, persistSecurityEvent, systemFingerprint } from './events.js';
import { createClamdScanner } from './malware-scan.js';
import { runUploadBackfill, type BackfillAsset } from './upload-backfill.js';
import { inspectUpload } from './upload-inspection.js';

/**
 * W8 backfill: inspect files that were already `ready` before W8.
 *
 *   npm --prefix apps/api run security:upload-backfill            # dry run
 *   npm --prefix apps/api run security:upload-backfill -- --apply # quarantine
 *
 * Uses UPLOAD_MALWARE_SCANNER like the API. Exits non-zero if any asset could
 * not be inspected or any finding could not be recorded, so a partial run is
 * never mistaken for a clean one.
 */
const sources = {
  content: {
    sql: `SELECT storage_asset_id::text AS id, owner_user_id::text AS owner, bucket_name, object_key,
        COALESCE(verified_content_type, declared_content_type) AS media_type,
        COALESCE(verified_byte_size, declared_byte_size)::text AS size
      FROM storage_assets
      WHERE asset_status = 'ready' AND ($1::uuid IS NULL OR storage_asset_id > $1::uuid)
      ORDER BY storage_asset_id LIMIT $2`,
    quarantine: `UPDATE storage_assets SET asset_status = 'quarantined', updated_at = now()
      WHERE storage_asset_id = $1 AND asset_status = 'ready' AND object_key = $2`,
  },
  course: {
    // Hosted-video sources go through the transcoding pipeline instead.
    sql: `SELECT course_delivery_asset_id::text AS id, owner_user_id::text AS owner, bucket_name, object_key,
        COALESCE(verified_content_type, declared_content_type) AS media_type,
        COALESCE(verified_byte_size, declared_byte_size)::text AS size
      FROM course_delivery_assets
      WHERE asset_status = 'ready' AND asset_purpose = 'cloud_download'
        AND ($1::uuid IS NULL OR course_delivery_asset_id > $1::uuid)
      ORDER BY course_delivery_asset_id LIMIT $2`,
    quarantine: `UPDATE course_delivery_assets SET asset_status = 'quarantined', updated_at = now()
      WHERE course_delivery_asset_id = $1 AND asset_status = 'ready' AND object_key = $2`,
  },
} as const;

type Row = { id: string; owner: string; bucket_name: string; object_key: string; media_type: string; size: string };

async function main() {
  const apply = process.argv.includes('--apply');
  const scanner = env.UPLOAD_MALWARE_SCANNER === 'clamav'
    ? createClamdScanner({ host: env.CLAMAV_HOST, port: env.CLAMAV_PORT, timeoutMs: env.CLAMAV_TIMEOUT_MS })
    : null;
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 2, ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined });
  try {
    const summary = await runUploadBackfill({
      async listReady(kind, afterId, limit) {
        const result = await pool.query<Row>(sources[kind].sql, [afterId, limit]);
        return result.rows.map((row): BackfillAsset => ({
          kind, id: row.id, ownerUserId: row.owner, bucketName: row.bucket_name, objectKey: row.object_key,
          mediaType: row.media_type, byteSize: Number(row.size),
        }));
      },
      async inspect(asset) {
        const locator = { bucketName: asset.bucketName, objectKey: asset.objectKey };
        const head = await findStoredObject(locator);
        if (!head?.etag) throw new Error('object is missing from storage');
        const etag = head.etag;
        return inspectUpload({ declaredMediaType: asset.mediaType, byteSize: head.contentLength ?? asset.byteSize }, {
          readHead: (bytes) => readStoredObject(locator, etag, bytes),
          readAll: () => readStoredObject(locator, etag),
          stream: () => streamStoredObject(locator, etag),
        }, scanner);
      },
      async quarantine(asset) {
        const result = await pool.query(sources[asset.kind].quarantine, [asset.id, asset.objectKey]);
        return (result.rowCount ?? 0) > 0;
      },
      async record(asset, verdict, quarantined) {
        await persistSecurityEvent(systemFingerprint(), {
          type: verdict.eventType,
          actorUserId: asset.ownerUserId,
          decision: quarantined ? 'deny' : 'allow',
          ruleHits: [verdict.reason, ...(verdict.archiveReason ? [verdict.archiveReason] : [])],
          context: {
            source: 'w8-backfill', assetId: asset.id, assetKind: asset.kind, declaredType: asset.mediaType,
            detected: verdict.detected ?? null, malware: verdict.signature ?? null, detail: verdict.detail, quarantined,
          },
        });
      },
    }, {
      apply,
      onError: (asset, error) => process.stderr.write(
        `${asset.kind} asset ${asset.id}: ${error instanceof Error ? error.message : String(error)}\n`),
    });
    for (const rejected of summary.rejectedAssets) {
      process.stdout.write(`REJECTED ${rejected.kind} ${rejected.id}: ${rejected.reason}\n`);
    }
    process.stdout.write(
      `Upload backfill (${apply ? 'APPLY' : 'dry run'}; malware scan ${scanner ? 'on' : 'OFF'}): inspected ${summary.inspected}, `
      + `rejected ${summary.rejected}, quarantined ${summary.quarantined}, `
      + `${summary.inspectionErrors} could not be inspected, ${summary.recordFailures} event write(s) failed.\n`,
    );
    if (summary.inspectionErrors > 0 || summary.recordFailures > 0) process.exitCode = 1;
  } finally {
    // A high-severity finding dispatches an alert; let it finish, then close
    // Redis so the process can exit and the scheduler sees the exit code.
    await drainSecurityAlerts();
    await closeRedis();
    await pool.end();
    await closeDatabase();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
