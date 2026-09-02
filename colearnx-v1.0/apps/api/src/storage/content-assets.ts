import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { query, withTransaction } from '../db/database.js';
import { ApiError, ok } from '../lib/http.js';
import { idempotencyKey, parse, uuid } from '../lib/validation.js';
import {
  contentTypeMatches,
  createContentObjectKey,
  deleteStoredObject,
  headUploadedObject,
  signDownload,
  signUpload,
  validateUploadMetadata,
  type HeadedObject,
  type UploadMetadata,
} from './r2.js';
import { storageQuotaViolation } from './storage-quota.js';
import { env } from '../config/env.js';

const uploadIntentInput = z.object({
  filename: z.string().trim().min(1).max(512),
  mediaType: z.string().trim().min(1).max(255),
  sizeBytes: z.coerce.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();

type AssetRow = {
  storage_asset_id: string;
  content_version_id: string;
  owner_user_id: string;
  bucket_name: string;
  object_key: string;
  original_filename: string;
  declared_content_type: string;
  declared_byte_size: string;
  verified_content_type: string | null;
  verified_byte_size: string | null;
  etag: string | null;
  asset_status: string;
  upload_expires_at: Date;
};

type DraftVersion = {
  content_version_id: string;
  content_id: string;
  creator_user_id: string;
  publication_status: string;
  version_status: string;
  storage_asset_id: string | null;
};

type UploadIntentRecord = { assetId: string; expiresAt: string };

function requireCreator(actor: Actor) {
  if (!actor.roles.includes('creator')) {
    throw new ApiError(403, 'CREATOR_ROLE_REQUIRED', 'An approved creator role is required.');
  }
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function numberFromDatabase(value: string | null) {
  return value === null ? null : Number(value);
}

function assetResponse(asset: AssetRow) {
  return {
    assetId: asset.storage_asset_id,
    status: asset.asset_status,
    filename: asset.original_filename,
    mediaType: asset.verified_content_type ?? asset.declared_content_type,
    sizeBytes: numberFromDatabase(asset.verified_byte_size ?? asset.declared_byte_size),
  };
}

function pendingAssetResponse(asset: AssetRow, uploadUrl: string) {
  return {
    assetId: asset.storage_asset_id,
    uploadUrl,
    method: 'PUT' as const,
    requiredHeaders: { 'Content-Type': asset.declared_content_type },
    expiresAt: asset.upload_expires_at.toISOString(),
  };
}

function expired(date: Date) {
  return date.getTime() <= Date.now();
}

async function lockOwnedDraftVersion(client: PoolClient, actorId: string, contentVersionId: string): Promise<DraftVersion> {
  const result = await client.query<DraftVersion>(`SELECT cv.content_version_id, cv.content_id, cv.storage_asset_id,
      c.creator_user_id, c.publication_status, cv.version_status
    FROM content_versions cv JOIN contents c ON c.content_id = cv.content_id
    WHERE cv.content_version_id = $1
    FOR UPDATE OF cv, c`, [contentVersionId]);
  if (!result.rowCount || result.rows[0].creator_user_id !== actorId) {
    throw new ApiError(404, 'CONTENT_VERSION_NOT_FOUND', 'Content version was not found.');
  }
  const version = result.rows[0];
  if (version.publication_status !== 'draft' || version.version_status !== 'draft') {
    throw new ApiError(409, 'CONTENT_VERSION_NOT_DRAFT', 'Only draft content versions can be changed.');
  }
  return version;
}

async function audit(client: PoolClient, actorId: string, action: string, assetId: string, requestId: string | undefined, details: Record<string, unknown>) {
  await client.query(`INSERT INTO admin_action_logs
      (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
    VALUES ($1, $2, 'storage_assets', $3, $4::jsonb, $5)`,
  [actorId, action, assetId, JSON.stringify(details), requestId ?? null]);
}

async function pendingAsset(client: PoolClient, assetId: string, contentVersionId: string, ownerUserId: string) {
  const result = await client.query<AssetRow>(`SELECT storage_asset_id, content_version_id, owner_user_id, bucket_name, object_key,
      original_filename, declared_content_type, declared_byte_size, verified_content_type, verified_byte_size, etag,
      asset_status, upload_expires_at
    FROM storage_assets
    WHERE storage_asset_id = $1 AND content_version_id = $2 AND owner_user_id = $3
    FOR UPDATE`, [assetId, contentVersionId, ownerUserId]);
  if (!result.rowCount) throw new ApiError(404, 'UPLOAD_INTENT_NOT_FOUND', 'Upload intent was not found.');
  return result.rows[0];
}

function readIntentRecord(value: unknown): UploadIntentRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.assetId === 'string' && typeof record.expiresAt === 'string'
    ? { assetId: record.assetId, expiresAt: record.expiresAt }
    : undefined;
}

type StorageUsage = {
  used_bytes: string;
  pending_uploads: string;
};

async function assertCreatorStorageQuota(client: PoolClient, ownerUserId: string, requestedBytes: number) {
  // Serialize quota checks for one creator. Without this lock, two browser tabs
  // could both pass the check and exceed the account cap.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ownerUserId]);
  const usage = await client.query<StorageUsage>(`SELECT
      COALESCE(sum(COALESCE(verified_byte_size, declared_byte_size)), 0)::text AS used_bytes,
      count(*) FILTER (
        WHERE asset_status IN ('pending', 'uploaded') AND upload_expires_at > now()
      )::text AS pending_uploads
    FROM storage_assets
    WHERE owner_user_id = $1 AND asset_status <> 'deleted'`, [ownerUserId]);
  const current = usage.rows[0];
  const violation = storageQuotaViolation({
    usedBytes: Number(current.used_bytes),
    pendingUploads: Number(current.pending_uploads),
    requestedBytes,
    maxBytes: env.CONTENT_STORAGE_QUOTA_BYTES,
    maxPendingUploads: env.CONTENT_PENDING_UPLOAD_LIMIT,
  });
  if (violation) throw new ApiError(violation.status, violation.code, violation.message);
}
export async function createUploadIntent(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  requireCreator(actor);
  const contentVersionId = parse(uuid, req.params.contentVersionId);
  const idempotency = parse(idempotencyKey, req.get('idempotency-key'));
  const metadata = validateUploadMetadata(parse(uploadIntentInput, req.body) as UploadMetadata);
  const requestFingerprint = fingerprint({ contentVersionId, ...metadata });

  const asset = await withTransaction(async (client) => {
    await lockOwnedDraftVersion(client, actor.id, contentVersionId);
    const existing = await client.query<{ request_fingerprint: string; response_body: unknown }>(`SELECT request_fingerprint, response_body
      FROM idempotency_records
      WHERE actor_user_id = $1 AND operation_scope = 'content_upload_intent' AND idempotency_key = $2
      FOR UPDATE`, [actor.id, idempotency]);
    if (existing.rowCount) {
      if (existing.rows[0].request_fingerprint !== requestFingerprint) {
        throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'The idempotency key was used for a different request.');
      }
      const record = readIntentRecord(existing.rows[0].response_body);
      if (!record) throw new ApiError(409, 'UPLOAD_INTENT_NOT_REUSABLE', 'The upload intent cannot be replayed.');
      const replay = await pendingAsset(client, record.assetId, contentVersionId, actor.id);
      if (replay.asset_status !== 'pending' || expired(replay.upload_expires_at)) {
        throw new ApiError(409, 'UPLOAD_INTENT_EXPIRED', 'The upload intent has expired. Start a new upload.');
      }
      return replay;
    }

    await assertCreatorStorageQuota(client, actor.id, metadata.sizeBytes);

    const uploadExpiresAt = new Date(Date.now() + env.R2_SIGNED_UPLOAD_TTL_SECONDS * 1000);
    const objectKey = createContentObjectKey(actor.id, contentVersionId, metadata.filename);
    const created = await client.query<AssetRow>(`INSERT INTO storage_assets
      (content_version_id, owner_user_id, bucket_name, object_key, original_filename, declared_content_type,
       declared_byte_size, checksum_sha256, upload_expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING storage_asset_id, content_version_id, owner_user_id, bucket_name, object_key, original_filename,
        declared_content_type, declared_byte_size, verified_content_type, verified_byte_size, etag, asset_status,
        upload_expires_at`, [
      contentVersionId, actor.id, env.R2_BUCKET_NAME, objectKey, metadata.filename, metadata.mediaType,
      metadata.sizeBytes, metadata.sha256 ?? null, uploadExpiresAt,
    ]);
    const stored = created.rows[0];
    const record: UploadIntentRecord = { assetId: stored.storage_asset_id, expiresAt: stored.upload_expires_at.toISOString() };
    await client.query(`INSERT INTO idempotency_records
        (actor_user_id, operation_scope, idempotency_key, request_fingerprint, response_status, response_body, completed_at)
      VALUES ($1, 'content_upload_intent', $2, $3, 201, $4::jsonb, now())`,
    [actor.id, idempotency, requestFingerprint, JSON.stringify(record)]);
    await audit(client, actor.id, 'content.upload.initialized', stored.storage_asset_id, res.locals.requestId, {
      contentVersionId, sizeBytes: metadata.sizeBytes, mediaType: metadata.mediaType, outcome: 'success',
    });
    return stored;
  });

  const uploadUrl = await signUpload({ bucketName: asset.bucket_name, objectKey: asset.object_key }, asset.declared_content_type);
  return ok(res, pendingAssetResponse(asset, uploadUrl), 201);
}

function mismatch(head: HeadedObject, asset: AssetRow) {
  return head.contentLength !== Number(asset.declared_byte_size) || !contentTypeMatches(asset.declared_content_type, head.contentType);
}

async function bestEffortDelete(asset: Pick<AssetRow, 'storage_asset_id' | 'bucket_name' | 'object_key'>) {
  try {
    await deleteStoredObject({ bucketName: asset.bucket_name, objectKey: asset.object_key });
    await query(`UPDATE storage_assets
      SET asset_status = 'deleted', deleted_at = now(), updated_at = now()
      WHERE storage_asset_id = $1 AND asset_status = 'delete_pending'`, [asset.storage_asset_id]);
  } catch {
    // The state remains delete_pending for a controlled maintenance retry.
  }
}

export async function completeUploadIntent(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  requireCreator(actor);
  const contentVersionId = parse(uuid, req.params.contentVersionId);
  const assetId = parse(uuid, req.params.assetId);

  const outcome = await withTransaction(async (client) => {
    const version = await lockOwnedDraftVersion(client, actor.id, contentVersionId);
    const asset = await pendingAsset(client, assetId, contentVersionId, actor.id);
    if (asset.asset_status === 'ready') return { kind: 'ready' as const, asset, previous: undefined };
    if (asset.asset_status !== 'pending') {
      throw new ApiError(409, 'UPLOAD_NOT_PENDING', 'This upload intent cannot be completed.');
    }
    if (expired(asset.upload_expires_at)) {
      throw new ApiError(409, 'UPLOAD_INTENT_EXPIRED', 'The upload intent has expired. Start a new upload.');
    }
    const headed = await headUploadedObject({ bucketName: asset.bucket_name, objectKey: asset.object_key });
    if (mismatch(headed, asset)) {
      await client.query(`UPDATE storage_assets
        SET asset_status = 'quarantined', verified_content_type = $2, verified_byte_size = $3, etag = $4,
          uploaded_at = now(), updated_at = now()
        WHERE storage_asset_id = $1`, [asset.storage_asset_id, headed.contentType?.split(';', 1)[0]?.trim() ?? null,
        headed.contentLength && headed.contentLength > 0 ? headed.contentLength : null, headed.etag ?? null]);
      return { kind: 'mismatch' as const, asset, previous: undefined };
    }

    let previous: AssetRow | undefined;
    if (version.storage_asset_id && version.storage_asset_id !== asset.storage_asset_id) {
      const previousResult = await client.query<AssetRow>(`SELECT storage_asset_id, content_version_id, owner_user_id,
          bucket_name, object_key, original_filename, declared_content_type, declared_byte_size,
          verified_content_type, verified_byte_size, etag, asset_status, upload_expires_at
        FROM storage_assets WHERE storage_asset_id = $1 FOR UPDATE`, [version.storage_asset_id]);
      previous = previousResult.rows[0];
      if (previous) {
        await client.query(`UPDATE storage_assets SET asset_status = 'delete_pending', updated_at = now()
          WHERE storage_asset_id = $1 AND asset_status <> 'deleted'`, [previous.storage_asset_id]);
      }
    }
    await client.query(`UPDATE storage_assets
      SET asset_status = 'ready', verified_content_type = $2, verified_byte_size = $3, etag = $4,
        uploaded_at = now(), verified_at = now(), updated_at = now()
      WHERE storage_asset_id = $1`, [asset.storage_asset_id, asset.declared_content_type, Number(asset.declared_byte_size), headed.etag ?? null]);
    await client.query(`UPDATE content_versions SET storage_asset_id = $2 WHERE content_version_id = $1`, [contentVersionId, asset.storage_asset_id]);
    await audit(client, actor.id, 'content.upload.completed', asset.storage_asset_id, res.locals.requestId, {
      contentVersionId, sizeBytes: Number(asset.declared_byte_size), mediaType: asset.declared_content_type, outcome: 'success',
    });
    return { kind: 'ready' as const, asset: { ...asset, asset_status: 'ready', verified_content_type: asset.declared_content_type,
      verified_byte_size: asset.declared_byte_size }, previous };
  });

  if (outcome.kind === 'mismatch') {
    throw new ApiError(409, 'UPLOAD_OBJECT_MISMATCH', 'The uploaded file did not match its upload intent.');
  }
  if (outcome.previous) await bestEffortDelete(outcome.previous);
  return ok(res, assetResponse(outcome.asset));
}

export async function deleteUploadIntent(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  requireCreator(actor);
  const contentVersionId = parse(uuid, req.params.contentVersionId);
  const assetId = parse(uuid, req.params.assetId);

  const asset = await withTransaction(async (client) => {
    const version = await lockOwnedDraftVersion(client, actor.id, contentVersionId);
    const stored = await pendingAsset(client, assetId, contentVersionId, actor.id);
    if (stored.asset_status === 'deleted') return stored;
    if (version.storage_asset_id === stored.storage_asset_id) {
      await client.query(`UPDATE content_versions SET storage_asset_id = NULL WHERE content_version_id = $1`, [contentVersionId]);
    }
    await client.query(`UPDATE storage_assets SET asset_status = 'delete_pending', updated_at = now()
      WHERE storage_asset_id = $1`, [stored.storage_asset_id]);
    await audit(client, actor.id, 'content.upload.deleted', stored.storage_asset_id, res.locals.requestId, { contentVersionId, outcome: 'pending_delete' });
    return stored;
  });

  if (asset.asset_status !== 'deleted') await bestEffortDelete(asset);
  const status = await query<{ asset_status: string }>('SELECT asset_status FROM storage_assets WHERE storage_asset_id = $1', [assetId]);
  return ok(res, { assetId, status: status.rows[0]?.asset_status ?? 'delete_pending' });
}

export async function previewContentAsset(req: Request, res: Response) {
  const contentVersionId = parse(uuid, req.params.contentVersionId);
  const result = await query<AssetRow>(`SELECT sa.storage_asset_id, sa.content_version_id, sa.owner_user_id, sa.bucket_name,
      sa.object_key, sa.original_filename, sa.declared_content_type, sa.declared_byte_size, sa.verified_content_type,
      sa.verified_byte_size, sa.etag, sa.asset_status, sa.upload_expires_at
    FROM content_versions cv JOIN storage_assets sa ON sa.storage_asset_id = cv.storage_asset_id
    WHERE cv.content_version_id = $1 AND sa.asset_status = 'ready'`, [contentVersionId]);
  if (!result.rowCount) throw new ApiError(404, 'CONTENT_VERSION_NOT_FOUND', 'A ready content file was not found.');
  const asset = result.rows[0];
  const previewUrl = await signDownload({ bucketName: asset.bucket_name, objectKey: asset.object_key },
    asset.verified_content_type ?? asset.declared_content_type, asset.original_filename, 'inline');
  return ok(res, { ...assetResponse(asset), previewUrl,
    expiresAt: new Date(Date.now() + env.R2_SIGNED_DOWNLOAD_TTL_SECONDS * 1000).toISOString() });
}

export async function createContentDownloadUrl(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const contentVersionId = parse(uuid, req.params.contentVersionId);
  const result = await query<AssetRow & { creator_user_id: string; has_grant: boolean }>(`SELECT sa.storage_asset_id,
      sa.content_version_id, sa.owner_user_id, sa.bucket_name, sa.object_key, sa.original_filename,
      sa.declared_content_type, sa.declared_byte_size, sa.verified_content_type, sa.verified_byte_size, sa.etag,
      sa.asset_status, sa.upload_expires_at, c.creator_user_id,
      EXISTS (SELECT 1 FROM content_access_grants cag
        WHERE cag.content_version_id = cv.content_version_id AND cag.user_id = $2
          AND (cag.expires_at IS NULL OR cag.expires_at > now())) AS has_grant
    FROM content_versions cv
    JOIN contents c ON c.content_id = cv.content_id
    JOIN storage_assets sa ON sa.storage_asset_id = cv.storage_asset_id
      AND sa.content_version_id = cv.content_version_id
    WHERE cv.content_version_id = $1 AND c.publication_status = 'published'
      AND cv.version_status = 'published' AND sa.asset_status = 'ready'`, [contentVersionId, actor.id]);
  if (!result.rowCount) throw new ApiError(404, 'CONTENT_VERSION_NOT_FOUND', 'A downloadable content file was not found.');
  const asset = result.rows[0];
  const privileged = asset.creator_user_id === actor.id || actor.roles.includes('admin');
  if (!privileged && !asset.has_grant) {
    throw new ApiError(403, 'CONTENT_ACCESS_DENIED', 'You do not have access to this content file.');
  }
  const downloadUrl = await signDownload({ bucketName: asset.bucket_name, objectKey: asset.object_key },
    asset.verified_content_type ?? asset.declared_content_type, asset.original_filename, 'attachment');
  if (!privileged) {
    await query(`UPDATE content_access_grants SET first_accessed_at = COALESCE(first_accessed_at, now())
      WHERE content_version_id = $1 AND user_id = $2 AND (expires_at IS NULL OR expires_at > now())`, [contentVersionId, actor.id]);
  }
  return ok(res, { filename: asset.original_filename,
    mediaType: asset.verified_content_type ?? asset.declared_content_type,
    sizeBytes: numberFromDatabase(asset.verified_byte_size ?? asset.declared_byte_size), downloadUrl,
    expiresAt: new Date(Date.now() + env.R2_SIGNED_DOWNLOAD_TTL_SECONDS * 1000).toISOString() });
}
