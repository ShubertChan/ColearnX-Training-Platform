import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { query, withTransaction } from '../db/database.js';
import { ApiError, ok } from '../lib/http.js';
import { idempotencyKey, parse, uuid } from '../lib/validation.js';
import { env } from '../config/env.js';
import {
  contentTypeMatches,
  createCourseObjectKey,
  deleteStoredObject,
  headUploadedObject,
  signDownload,
  signUpload,
  validateUploadMetadata,
  type HeadedObject,
  type UploadMetadata,
} from './r2.js';
import { canFinalizeStorageAssetDeletion, remainingSignedUploadTtlSeconds } from './storage-deletion.js';

const uploadIntentInput = z.object({
  filename: z.string().trim().min(1).max(512),
  mediaType: z.string().trim().min(1).max(255),
  sizeBytes: z.coerce.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();
const assetSelectionInput = z.object({ assetId: uuid }).strict();
const progressInput = z.object({
  sessionId: uuid,
  watchedSeconds: z.coerce.number().finite().nonnegative(),
  totalDurationSeconds: z.coerce.number().int().positive(),
  watchedRanges: z.array(z.tuple([z.coerce.number().finite().nonnegative(), z.coerce.number().finite().nonnegative()]))
    .max(100),
}).strict();

type CourseAsset = {
  course_delivery_asset_id: string;
  course_run_id: string;
  owner_user_id: string;
  asset_purpose: 'cloud_download' | 'online_video';
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

type DraftCourse = {
  course_run_id: string;
  owner_user_id: string;
  publication_status: string;
  run_status: string;
  progress_tracking_type: 'none' | 'online_video';
};

type PurchaseAccess = {
  order_item_id: string;
  course_run_id: string;
  enrolment_id: string;
  fulfilment_status: string;
  progress_tracking_type: 'none' | 'online_video';
  total_duration_seconds: number | null;
  delivery_snapshot_json: unknown;
};

type ProgressSession = {
  reported_watched_seconds: string;
  accepted_watched_seconds: string;
  started_at: Date;
  last_seen_at: Date;
};

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assetResponse(asset: CourseAsset) {
  return {
    assetId: asset.course_delivery_asset_id,
    status: asset.asset_status,
    filename: asset.original_filename,
    mediaType: asset.verified_content_type ?? asset.declared_content_type,
    sizeBytes: Number(asset.verified_byte_size ?? asset.declared_byte_size),
    purpose: asset.asset_purpose,
  };
}

function requireTrainer(actor: Actor) {
  if (!actor.roles.includes('trainer')) {
    throw new ApiError(403, 'TRAINER_ROLE_REQUIRED', 'An approved trainer role is required.');
  }
}

export async function assertTrainerOperational(client: Pick<PoolClient, 'query'>, actorId: string) {
  const certification = await client.query(`SELECT 1 FROM trainer_certifications
    WHERE trainer_user_id = $1 AND certification_status = 'approved'`, [actorId]);
  if (!certification.rowCount) {
    throw new ApiError(403, 'TRAINER_CERTIFICATION_REQUIRED', 'An approved trainer certification is required.');
  }
}

async function lockDraftCourse(client: PoolClient, actorId: string, courseRunId: string): Promise<DraftCourse> {
  const result = await client.query<DraftCourse>(`SELECT cr.course_run_id, c.owner_user_id, c.publication_status,
      cr.run_status, cr.progress_tracking_type
    FROM course_runs cr JOIN courses c ON c.course_id = cr.course_id
    WHERE cr.course_run_id = $1 FOR UPDATE OF cr, c`, [courseRunId]);
  const course = result.rows[0];
  if (!course || course.owner_user_id !== actorId) {
    throw new ApiError(404, 'COURSE_NOT_FOUND', 'Course offering was not found.');
  }
  if (course.publication_status !== 'draft' || course.run_status !== 'draft') {
    throw new ApiError(409, 'COURSE_NOT_DRAFT', 'Only draft course offerings can be changed.');
  }
  return course;
}

async function audit(client: PoolClient, actorId: string, action: string, assetId: string, requestId: string | undefined, details: Record<string, unknown>) {
  await client.query(`INSERT INTO admin_action_logs
    (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
    VALUES ($1, $2, 'course_delivery_assets', $3, $4::jsonb, $5)`,
  [actorId, action, assetId, JSON.stringify(details), requestId ?? null]);
}

async function pendingAsset(client: PoolClient, assetId: string, courseRunId: string, ownerUserId: string) {
  const result = await client.query<CourseAsset>(`SELECT course_delivery_asset_id, course_run_id, owner_user_id,
      asset_purpose, bucket_name, object_key, original_filename, declared_content_type, declared_byte_size,
      verified_content_type, verified_byte_size, etag, asset_status, upload_expires_at
    FROM course_delivery_assets
    WHERE course_delivery_asset_id = $1 AND course_run_id = $2 AND owner_user_id = $3
    FOR UPDATE`, [assetId, courseRunId, ownerUserId]);
  if (!result.rowCount) throw new ApiError(404, 'COURSE_UPLOAD_INTENT_NOT_FOUND', 'Course upload intent was not found.');
  return result.rows[0];
}

function expired(value: Date) {
  return value.getTime() <= Date.now();
}

function mismatch(head: HeadedObject, asset: CourseAsset) {
  return head.contentLength !== Number(asset.declared_byte_size)
    || !contentTypeMatches(asset.declared_content_type, head.contentType);
}

function purposeFor(course: DraftCourse, metadata: UploadMetadata): 'cloud_download' | 'online_video' {
  return course.progress_tracking_type === 'online_video' && metadata.mediaType === 'video/mp4'
    ? 'online_video'
    : 'cloud_download';
}

export async function assertCourseReadyForSubmission(client: Pick<PoolClient, 'query'>, courseRunId: string, ownerUserId: string) {
  const course = await client.query<{ progress_tracking_type: 'none' | 'online_video'; total_duration_seconds: number | null }>(
    `SELECT cr.progress_tracking_type, cr.total_duration_seconds
     FROM course_runs cr JOIN courses c ON c.course_id = cr.course_id
     WHERE cr.course_run_id = $1 AND c.owner_user_id = $2`, [courseRunId, ownerUserId],
  );
  if (!course.rowCount) throw new ApiError(404, 'COURSE_NOT_FOUND', 'Course offering was not found.');
  const options = await client.query<{ delivery_type: string; fulfilment_instructions: string | null; trainer_contact: string | null }>(
    `SELECT delivery_type, fulfilment_instructions, trainer_contact
     FROM course_delivery_options WHERE course_run_id = $1`, [courseRunId],
  );
  if (!options.rowCount) throw new ApiError(409, 'COURSE_DELIVERY_UNAVAILABLE', 'A course must have a delivery option.');
  const coordinating = options.rows.some((option) => option.delivery_type === 'local' || option.delivery_type === 'live');
  if (coordinating && options.rows.some((option) =>
    (option.delivery_type === 'local' || option.delivery_type === 'live')
      && (!option.fulfilment_instructions?.trim() || !option.trainer_contact?.trim()))) {
    throw new ApiError(409, 'COURSE_COORDINATION_REQUIRED', 'Local and Live delivery require buyer-only instructions and Trainer contact details.');
  }
  const assets = await client.query<{ asset_purpose: string; count: string }>(`SELECT asset_purpose, count(*)::text AS count
    FROM course_delivery_assets WHERE course_run_id = $1 AND owner_user_id = $2 AND asset_status = 'ready'
    GROUP BY asset_purpose`, [courseRunId, ownerUserId]);
  const ready = new Map(assets.rows.map((row) => [row.asset_purpose, Number(row.count)]));
  if (options.rows.some((option) => option.delivery_type === 'cloud') && !ready.get('cloud_download') && !(course.rows[0].progress_tracking_type === 'online_video' && ready.get('online_video'))) {
    throw new ApiError(409, 'COURSE_FILE_NOT_READY', 'Cloud delivery requires a verified protected course file.');
  }
  if (course.rows[0].progress_tracking_type === 'online_video') {
    if (!course.rows[0].total_duration_seconds || !ready.get('online_video')) {
      throw new ApiError(409, 'COURSE_VIDEO_NOT_READY', 'Online video requires a verified MP4 file and a total duration.');
    }
  }
}

export async function listCourseAssets(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const courseRunId = parse(uuid, req.params.courseRunId);
  const course = await query<{ owner_user_id: string }>(`SELECT c.owner_user_id FROM course_runs cr
    JOIN courses c ON c.course_id = cr.course_id WHERE cr.course_run_id = $1`, [courseRunId]);
  if (!course.rowCount) throw new ApiError(404, 'COURSE_NOT_FOUND', 'Course offering was not found.');
  if (course.rows[0].owner_user_id !== actor.id && !actor.roles.includes('admin')) {
    throw new ApiError(403, 'COURSE_ASSET_ACCESS_DENIED', 'You do not have access to course upload files.');
  }
  const assets = await query<CourseAsset>(`SELECT course_delivery_asset_id, course_run_id, owner_user_id, asset_purpose,
    bucket_name, object_key, original_filename, declared_content_type, declared_byte_size, verified_content_type,
    verified_byte_size, etag, asset_status, upload_expires_at
    FROM course_delivery_assets WHERE course_run_id = $1 AND asset_status <> 'deleted' ORDER BY created_at ASC`, [courseRunId]);
  return ok(res, { assets: assets.rows.map(assetResponse) });
}

export async function createCourseUploadIntent(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  requireTrainer(actor);
  const courseRunId = parse(uuid, req.params.courseRunId);
  const key = parse(idempotencyKey, req.get('idempotency-key'));
  const metadata = validateUploadMetadata(parse(uploadIntentInput, req.body) as UploadMetadata);
  const requestFingerprint = fingerprint({ courseRunId, ...metadata });
  const outcome = await withTransaction(async (client) => {
    const course = await lockDraftCourse(client, actor.id, courseRunId);
    await assertTrainerOperational(client, actor.id);
    const existing = await client.query<{ request_fingerprint: string; response_body: { assetId?: string } | null }>(`SELECT request_fingerprint, response_body
      FROM idempotency_records WHERE actor_user_id = $1 AND operation_scope = 'course_upload_intent' AND idempotency_key = $2 FOR UPDATE`, [actor.id, key]);
    if (existing.rowCount) {
      if (existing.rows[0].request_fingerprint !== requestFingerprint) {
        throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'The idempotency key was used for a different request.');
      }
      const assetId = existing.rows[0].response_body?.assetId;
      if (!assetId) throw new ApiError(409, 'UPLOAD_INTENT_NOT_REUSABLE', 'The upload intent cannot be replayed.');
      const asset = await pendingAsset(client, assetId, courseRunId, actor.id);
      if (asset.asset_status !== 'pending' || expired(asset.upload_expires_at)) {
        throw new ApiError(409, 'UPLOAD_INTENT_EXPIRED', 'The upload intent has expired. Start a new upload.');
      }
      return asset;
    }
    const expiresAt = new Date(Date.now() + env.R2_SIGNED_UPLOAD_TTL_SECONDS * 1000);
    const created = await client.query<CourseAsset>(`INSERT INTO course_delivery_assets
      (course_run_id, owner_user_id, asset_purpose, bucket_name, object_key, original_filename,
       declared_content_type, declared_byte_size, checksum_sha256, upload_expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING course_delivery_asset_id, course_run_id, owner_user_id, asset_purpose, bucket_name, object_key,
       original_filename, declared_content_type, declared_byte_size, verified_content_type, verified_byte_size,
       etag, asset_status, upload_expires_at`, [
      courseRunId, actor.id, purposeFor(course, metadata), env.R2_BUCKET_NAME,
      createCourseObjectKey(actor.id, courseRunId, metadata.filename), metadata.filename, metadata.mediaType,
      metadata.sizeBytes, metadata.sha256 ?? null, expiresAt,
    ]);
    const asset = created.rows[0];
    await client.query(`INSERT INTO idempotency_records
      (actor_user_id, operation_scope, idempotency_key, request_fingerprint, response_status, response_body, completed_at)
      VALUES ($1, 'course_upload_intent', $2, $3, 201, $4::jsonb, now())`,
    [actor.id, key, requestFingerprint, JSON.stringify({ assetId: asset.course_delivery_asset_id })]);
    await audit(client, actor.id, 'course.upload.initialized', asset.course_delivery_asset_id, res.locals.requestId, {
      courseRunId, purpose: asset.asset_purpose, sizeBytes: metadata.sizeBytes, outcome: 'success',
    });
    return asset;
  });
  const ttl = remainingSignedUploadTtlSeconds(outcome.upload_expires_at);
  if (ttl < 1) throw new ApiError(409, 'UPLOAD_INTENT_EXPIRED', 'The upload intent has expired. Start a new upload.');
  const uploadUrl = await signUpload({ bucketName: outcome.bucket_name, objectKey: outcome.object_key }, outcome.declared_content_type, ttl);
  return ok(res, {
    assetId: outcome.course_delivery_asset_id, uploadUrl, method: 'PUT',
    requiredHeaders: { 'Content-Type': outcome.declared_content_type }, expiresAt: outcome.upload_expires_at.toISOString(),
  }, 201);
}

export async function completeCourseUploadIntent(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  requireTrainer(actor);
  const courseRunId = parse(uuid, req.params.courseRunId);
  const assetId = parse(uuid, req.params.assetId);
  const completed = await withTransaction(async (client) => {
    await lockDraftCourse(client, actor.id, courseRunId);
    await assertTrainerOperational(client, actor.id);
    const asset = await pendingAsset(client, assetId, courseRunId, actor.id);
    if (asset.asset_status === 'ready') return asset;
    if (asset.asset_status !== 'pending' || expired(asset.upload_expires_at)) {
      throw new ApiError(409, 'UPLOAD_NOT_PENDING', 'This upload intent cannot be completed.');
    }
    const headed = await headUploadedObject({ bucketName: asset.bucket_name, objectKey: asset.object_key });
    if (mismatch(headed, asset)) {
      await client.query(`UPDATE course_delivery_assets SET asset_status = 'quarantined',
        verified_content_type = $2, verified_byte_size = $3, etag = $4, uploaded_at = now(), updated_at = now()
        WHERE course_delivery_asset_id = $1`, [assetId, headed.contentType?.split(';', 1)[0]?.trim() ?? null,
        headed.contentLength && headed.contentLength > 0 ? headed.contentLength : null, headed.etag ?? null]);
      throw new ApiError(409, 'UPLOAD_OBJECT_MISMATCH', 'The uploaded file did not match its upload intent.');
    }
    const result = await client.query<CourseAsset>(`UPDATE course_delivery_assets SET asset_status = 'ready',
      verified_content_type = $2, verified_byte_size = $3, etag = $4, uploaded_at = now(), verified_at = now(), updated_at = now()
      WHERE course_delivery_asset_id = $1
      RETURNING course_delivery_asset_id, course_run_id, owner_user_id, asset_purpose, bucket_name, object_key,
       original_filename, declared_content_type, declared_byte_size, verified_content_type, verified_byte_size,
       etag, asset_status, upload_expires_at`, [assetId, asset.declared_content_type, Number(asset.declared_byte_size), headed.etag ?? null]);
    await audit(client, actor.id, 'course.upload.completed', assetId, res.locals.requestId, { courseRunId, outcome: 'success' });
    return result.rows[0];
  });
  return ok(res, assetResponse(completed));
}

export async function deleteCourseUploadIntent(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  requireTrainer(actor);
  const courseRunId = parse(uuid, req.params.courseRunId);
  const assetId = parse(uuid, req.params.assetId);
  const asset = await withTransaction(async (client) => {
    await lockDraftCourse(client, actor.id, courseRunId);
    await assertTrainerOperational(client, actor.id);
    const stored = await pendingAsset(client, assetId, courseRunId, actor.id);
    if (stored.asset_status === 'deleted') return stored;
    await client.query(`UPDATE course_delivery_assets SET asset_status = 'delete_pending', updated_at = now()
      WHERE course_delivery_asset_id = $1`, [assetId]);
    await audit(client, actor.id, 'course.upload.deleted', assetId, res.locals.requestId, { courseRunId, outcome: 'pending_delete' });
    return stored;
  });
  try {
    await deleteStoredObject({ bucketName: asset.bucket_name, objectKey: asset.object_key });
    if (canFinalizeStorageAssetDeletion(asset.upload_expires_at)) {
      await query(`UPDATE course_delivery_assets SET asset_status = 'deleted', deleted_at = now(), updated_at = now()
        WHERE course_delivery_asset_id = $1 AND asset_status = 'delete_pending'`, [asset.course_delivery_asset_id]);
    }
  } catch {
    // The database state remains retryable for controlled reconciliation.
  }
  const status = await query<{ asset_status: string }>('SELECT asset_status FROM course_delivery_assets WHERE course_delivery_asset_id = $1', [assetId]);
  return ok(res, { assetId, status: status.rows[0]?.asset_status ?? 'delete_pending' });
}

async function purchaseAccess(client: Pick<PoolClient, 'query'>, orderItemId: string, actorId: string) {
  const result = await client.query<PurchaseAccess>(`SELECT oi.order_item_id, oi.course_run_id, ce.enrolment_id,
      oi.fulfilment_status, cr.progress_tracking_type, cr.total_duration_seconds, oi.delivery_snapshot_json
    FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
    JOIN course_enrolments ce ON ce.order_item_id = oi.order_item_id
    JOIN course_runs cr ON cr.course_run_id = oi.course_run_id
    WHERE oi.order_item_id = $1 AND o.buyer_user_id = $2 AND oi.item_type = 'course_run'
      AND oi.fulfilment_status IN ('paid', 'reserved', 'fulfilled')`, [orderItemId, actorId]);
  if (!result.rowCount) throw new ApiError(404, 'COURSE_DELIVERY_NOT_FOUND', 'Authorised course delivery was not found.');
  return result.rows[0];
}

function fulfilment(value: unknown) {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    instructions: typeof data.instructions === 'string' ? data.instructions : '',
    trainerContact: typeof data.trainerContact === 'string' ? data.trainerContact : '',
    joinUrl: typeof data.joinUrl === 'string' ? data.joinUrl : '',
  };
}

async function activeDeliveryOption(client: Pick<PoolClient, 'query'>, courseRunId: string, preferred?: string) {
  const result = await client.query<{ delivery_option_id: string }>(`SELECT delivery_option_id FROM course_delivery_options
    WHERE course_run_id = $1 AND option_status = 'active' AND ($2::text IS NULL OR delivery_type = $2)
    ORDER BY is_primary DESC, delivery_option_id ASC LIMIT 1`, [courseRunId, preferred ?? null]);
  if (!result.rowCount) throw new ApiError(409, 'COURSE_DELIVERY_UNAVAILABLE', 'This course has no active delivery option.');
  return result.rows[0].delivery_option_id;
}

async function currentProgress(client: PoolClient, access: PurchaseAccess, preferred?: string) {
  const deliveryOptionId = await activeDeliveryOption(client, access.course_run_id, preferred);
  await client.query(`INSERT INTO course_access_progress (enrolment_id, delivery_option_id, total_seconds)
    VALUES ($1, $2, $3) ON CONFLICT (enrolment_id, delivery_option_id) DO NOTHING`,
  [access.enrolment_id, deliveryOptionId, access.total_duration_seconds]);
  const progress = await client.query<{ access_progress_id: string; watched_seconds: number; total_seconds: number | null; watch_percent: string }>(
    `SELECT access_progress_id, watched_seconds, total_seconds, watch_percent FROM course_access_progress
     WHERE enrolment_id = $1 AND delivery_option_id = $2 FOR UPDATE`, [access.enrolment_id, deliveryOptionId],
  );
  return { deliveryOptionId, progress: progress.rows[0] };
}

export async function getCourseDelivery(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const orderItemId = parse(uuid, req.params.orderItemId);
  const access = await withTransaction((client) => purchaseAccess(client, orderItemId, actor.id));
  const assets = await query<CourseAsset>(`SELECT course_delivery_asset_id, course_run_id, owner_user_id, asset_purpose,
    bucket_name, object_key, original_filename, declared_content_type, declared_byte_size, verified_content_type,
    verified_byte_size, etag, asset_status, upload_expires_at FROM course_delivery_assets
    WHERE course_run_id = $1 AND asset_purpose = 'cloud_download' AND asset_status = 'ready' ORDER BY created_at ASC`, [access.course_run_id]);
  const video = access.progress_tracking_type === 'online_video'
    ? await query<CourseAsset>(`SELECT course_delivery_asset_id, course_run_id, owner_user_id, asset_purpose,
      bucket_name, object_key, original_filename, declared_content_type, declared_byte_size, verified_content_type,
      verified_byte_size, etag, asset_status, upload_expires_at FROM course_delivery_assets
      WHERE course_run_id = $1 AND asset_purpose = 'online_video' AND asset_status = 'ready'
      ORDER BY created_at ASC LIMIT 1`, [access.course_run_id])
    : { rows: [] as CourseAsset[] };
  const progress = access.progress_tracking_type === 'online_video'
    ? await withTransaction((client) => currentProgress(client, access))
    : null;
  const playbackUrl = video.rows[0]
    ? await signDownload({ bucketName: video.rows[0].bucket_name, objectKey: video.rows[0].object_key },
      video.rows[0].verified_content_type ?? video.rows[0].declared_content_type, video.rows[0].original_filename, 'inline')
    : null;
  return ok(res, {
    ...fulfilment(access.delivery_snapshot_json), assets: assets.rows.map(assetResponse),
    onlineVideo: access.progress_tracking_type === 'online_video', progressTrackingType: access.progress_tracking_type,
    playbackUrl, watchedSeconds: progress?.progress.watched_seconds ?? 0,
    totalDurationSeconds: access.total_duration_seconds ?? 0,
    progressPercent: Number(progress?.progress.watch_percent ?? 0),
  });
}

export async function createCourseDownloadUrl(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const orderItemId = parse(uuid, req.params.orderItemId);
  const assetId = parse(assetSelectionInput, req.body).assetId;
  const result = await withTransaction(async (client) => {
    const access = await purchaseAccess(client, orderItemId, actor.id);
    const asset = await client.query<CourseAsset>(`SELECT course_delivery_asset_id, course_run_id, owner_user_id, asset_purpose,
      bucket_name, object_key, original_filename, declared_content_type, declared_byte_size, verified_content_type,
      verified_byte_size, etag, asset_status, upload_expires_at FROM course_delivery_assets
      WHERE course_delivery_asset_id = $1 AND course_run_id = $2 AND asset_purpose = 'cloud_download' AND asset_status = 'ready'`,
    [assetId, access.course_run_id]);
    if (!asset.rowCount) throw new ApiError(404, 'COURSE_ASSET_NOT_FOUND', 'The authorised course file was not found.');
    const state = await currentProgress(client, access, 'cloud');
    await client.query(`UPDATE course_access_progress SET download_completed_at = COALESCE(download_completed_at, now()), updated_at = now()
      WHERE access_progress_id = $1`, [state.progress.access_progress_id]);
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, 'course.delivery.download.authorized', 'order_items', $2, jsonb_build_object('assetId', $3::uuid), $4)`,
    [actor.id, orderItemId, assetId, res.locals.requestId]);
    return asset.rows[0];
  });
  const downloadUrl = await signDownload({ bucketName: result.bucket_name, objectKey: result.object_key },
    result.verified_content_type ?? result.declared_content_type, result.original_filename, 'attachment');
  return ok(res, { assetId: result.course_delivery_asset_id, filename: result.original_filename, downloadUrl });
}

function mergedDuration(ranges: Array<[number, number]>, total: number) {
  const sorted = ranges.map(([start, end]) => [Math.max(0, start), Math.min(total, end)] as const)
    .filter(([start, end]) => end > start)
    .sort(([left], [right]) => left - right);
  let duration = 0; let start = -1; let end = -1;
  for (const [nextStart, nextEnd] of sorted) {
    if (start < 0) { start = nextStart; end = nextEnd; continue; }
    if (nextStart <= end) { end = Math.max(end, nextEnd); continue; }
    duration += end - start; start = nextStart; end = nextEnd;
  }
  return duration + (start < 0 ? 0 : end - start);
}

export async function recordCourseProgress(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const orderItemId = parse(uuid, req.params.orderItemId);
  const input = parse(progressInput, req.body);
  const response = await withTransaction(async (client) => {
    const access = await purchaseAccess(client, orderItemId, actor.id);
    if (access.progress_tracking_type !== 'online_video' || !access.total_duration_seconds) {
      throw new ApiError(409, 'COURSE_PROGRESS_NOT_TRACKED', 'This course does not use platform-hosted online-video progress.');
    }
    if (input.totalDurationSeconds !== access.total_duration_seconds) {
      throw new ApiError(409, 'COURSE_DURATION_MISMATCH', 'The player duration does not match the server-recorded course duration.');
    }
    const reported = Math.floor(mergedDuration(input.watchedRanges, access.total_duration_seconds));
    const { progress } = await currentProgress(client, access);
    const existing = await client.query<ProgressSession>(`SELECT reported_watched_seconds, accepted_watched_seconds, started_at, last_seen_at
      FROM course_video_progress_sessions WHERE order_item_id = $1 AND session_id = $2 FOR UPDATE`, [orderItemId, input.sessionId]);
    const now = new Date();
    const prior = existing.rows[0];
    const priorReported = Number(prior?.reported_watched_seconds ?? 0);
    const priorAccepted = Number(prior?.accepted_watched_seconds ?? 0);
    const elapsed = prior ? Math.max(0, (now.getTime() - prior.last_seen_at.getTime()) / 1000) : 0;
    // A browser can only report playback; it cannot dictate the ledger value.
    // The server accepts a bounded, monotonic increment and de-duplicates a
    // retried session report before it becomes refund evidence.
    const maximumIncrement = prior ? Math.floor(elapsed * 1.25 + 5) : Math.min(30, reported);
    const nextReported = Math.max(priorReported, reported);
    const increment = Math.max(0, Math.min(nextReported - priorAccepted, maximumIncrement,
      access.total_duration_seconds - progress.watched_seconds));
    const nextAccepted = priorAccepted + increment;
    if (prior) {
      await client.query(`UPDATE course_video_progress_sessions SET reported_watched_seconds = $3,
        accepted_watched_seconds = $4, last_seen_at = $5, updated_at = $5
        WHERE order_item_id = $1 AND session_id = $2`, [orderItemId, input.sessionId, nextReported, nextAccepted, now]);
    } else {
      await client.query(`INSERT INTO course_video_progress_sessions
        (order_item_id, session_id, reported_watched_seconds, accepted_watched_seconds, started_at, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, $5)`, [orderItemId, input.sessionId, nextReported, nextAccepted, now]);
    }
    const watchedSeconds = Math.min(access.total_duration_seconds, progress.watched_seconds + increment);
    const progressPercent = Number(((watchedSeconds / access.total_duration_seconds) * 100).toFixed(2));
    await client.query(`UPDATE course_access_progress SET watched_seconds = $2, total_seconds = $3, watch_percent = $4,
      first_started_at = COALESCE(first_started_at, now()), last_watched_at = now(), updated_at = now()
      WHERE access_progress_id = $1`, [progress.access_progress_id, watchedSeconds, access.total_duration_seconds, progressPercent]);
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, 'course.video.progress.recorded', 'order_items', $2,
       jsonb_build_object('watchedSeconds', $3, 'totalDurationSeconds', $4), $5)`,
    [actor.id, orderItemId, watchedSeconds, access.total_duration_seconds, res.locals.requestId]);
    return { watchedSeconds, totalDurationSeconds: access.total_duration_seconds, progressPercent };
  });
  return ok(res, response);
}
