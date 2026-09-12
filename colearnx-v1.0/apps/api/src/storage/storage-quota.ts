import type { PoolClient } from 'pg';
import { ApiError } from '../lib/http.js';

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
  requestedBytes: number, limits: Pick<StorageQuotaInput, 'maxBytes' | 'maxPendingUploads'>) {
  await lockStorageAccount(client, ownerUserId);
  const usage = await client.query<{ used_bytes: string; pending_uploads: string }>(`SELECT
    COALESCE(sum(GREATEST(declared_byte_size, COALESCE(verified_byte_size, declared_byte_size))), 0)::text AS used_bytes,
    count(*) FILTER (WHERE asset_status IN ('pending', 'uploaded') AND upload_expires_at > now())::text AS pending_uploads
    FROM (
      SELECT declared_byte_size, verified_byte_size, asset_status, upload_expires_at
      FROM storage_assets WHERE owner_user_id = $1 AND asset_status <> 'deleted'
      UNION ALL
      SELECT declared_byte_size, verified_byte_size, asset_status, upload_expires_at
      FROM course_delivery_assets WHERE owner_user_id = $1 AND asset_status <> 'deleted'
    ) account_assets`, [ownerUserId]);
  const current = usage.rows[0];
  const violation = storageQuotaViolation({ ...limits, requestedBytes,
    usedBytes: Number(current.used_bytes), pendingUploads: Number(current.pending_uploads) });
  if (violation) throw new ApiError(violation.status, violation.code, violation.message);
}
