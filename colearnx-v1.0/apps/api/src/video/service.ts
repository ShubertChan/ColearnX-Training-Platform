import { createHmac, createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { env } from '../config/env.js';
import { query, withTransaction } from '../db/database.js';
import { ApiError, ok } from '../lib/http.js';
import { idempotencyKey, parse, uuid } from '../lib/validation.js';
import { intervalFromHeartbeat, mergeIntervals, uniqueWatchedSeconds, type Heartbeat, type PlaybackEvent } from './progress.js';
import { enqueueVideoTranscode } from './queue.js';
import {
  VIDEO_MAX_PARTS,
  VIDEO_PART_SIZE_BYTES,
  abortMultipartVideoUpload,
  completeMultipartVideoUpload,
  createVideoSourceObjectKey,
  findVideoSource,
  headVideoSource,
  listMultipartVideoParts,
  signMultipartVideoPart,
  startMultipartVideoUpload,
  validateVideoSource,
} from './video-storage.js';

const uploadInput = z.object({ filename: z.string(), mediaType: z.string(), sizeBytes: z.coerce.number() }).strict();
const partInput = z.object({ partNumber: z.coerce.number().int().min(1).max(VIDEO_MAX_PARTS) }).strict();
const completePartsInput = z.object({ parts: z.array(z.object({ partNumber: z.coerce.number().int().min(1).max(VIDEO_MAX_PARTS), etag: z.string().trim().min(1).max(255) })).min(1).max(VIDEO_MAX_PARTS) }).strict();
const heartbeatInput = z.object({
  sessionId: uuid,
  sequence: z.coerce.number().int().min(1),
  event: z.enum(['playing', 'pause', 'seeking', 'seeked', 'ended']),
  positionSeconds: z.coerce.number().finite().nonnegative(),
  playbackRate: z.coerce.number().finite().positive().max(4),
  clientMonotonicMs: z.coerce.number().finite().nonnegative(),
}).strict();

type VideoStatus = 'upload_pending' | 'queued' | 'transcoding' | 'ready' | 'failed' | 'superseded' | 'delete_pending' | 'deleted';
type VideoVersion = {
  course_video_version_id: string;
  course_run_id: string;
  source_asset_id: string;
  video_status: VideoStatus;
  source_upload_id: string | null;
  source_upload_part_size_bytes: number;
  duration_seconds: string | null;
  width: number | null;
  height: number | null;
  hls_master_key: string | null;
  failure_code: string | null;
  failure_message: string | null;
  version_no: number;
  is_current: boolean;
  created_at: Date;
};

type VideoSourceRow = VideoVersion & {
  owner_user_id: string;
  publication_status: string;
  run_status: string;
  progress_tracking_type: 'none' | 'online_video';
  bucket_name: string;
  object_key: string;
  original_filename: string;
  declared_content_type: string;
  declared_byte_size: string;
  asset_status: string;
  upload_expires_at: Date;
};

function isTerminalVideoFailure(code: string | null) {
  return code === 'VIDEO_INVALID_SOURCE' || code === 'TRANSCODE_RETRIES_EXHAUSTED';
}

function requireHostedVideo() {
  if (!env.ENABLE_HOSTED_VIDEO) throw new ApiError(503, 'HOSTED_VIDEO_DISABLED', 'Hosted video is not enabled for this deployment.');
}

function requireTrainer(actor: Actor) {
  if (!actor.roles.includes('trainer')) throw new ApiError(403, 'TRAINER_ROLE_REQUIRED', 'An approved trainer role is required.');
}

async function assertTrainerOperational(client: Pick<PoolClient, 'query'>, actorId: string) {
  const certification = await client.query('SELECT 1 FROM trainer_certifications WHERE trainer_user_id = $1 AND certification_status = $2', [actorId, 'approved']);
  if (!certification.rowCount) throw new ApiError(403, 'TRAINER_CERTIFICATION_REQUIRED', 'An approved trainer certification is required.');
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function claimIdempotency(client: PoolClient, actorId: string, scope: string, key: string, body: unknown) {
  const requestFingerprint = fingerprint(body);
  const existing = await client.query<{ request_fingerprint: string; response_body: Record<string, unknown> | null }>(`SELECT request_fingerprint, response_body
    FROM idempotency_records WHERE actor_user_id = $1 AND operation_scope = $2 AND idempotency_key = $3 FOR UPDATE`, [actorId, scope, key]);
  if (existing.rowCount) {
    if (existing.rows[0].request_fingerprint !== requestFingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different request.');
    if (existing.rows[0].response_body) return { requestFingerprint, cached: existing.rows[0].response_body };
    throw new ApiError(409, 'REQUEST_IN_PROGRESS', 'The matching request is still processing.');
  }
  await client.query(`INSERT INTO idempotency_records (actor_user_id, operation_scope, idempotency_key, request_fingerprint)
    VALUES ($1, $2, $3, $4)`, [actorId, scope, key, requestFingerprint]);
  return { requestFingerprint, cached: null };
}

async function finishIdempotency(client: PoolClient, actorId: string, scope: string, key: string, requestFingerprint: string, response: Record<string, unknown>) {
  await client.query(`UPDATE idempotency_records SET response_status = 200, response_body = $5::jsonb, completed_at = now()
    WHERE actor_user_id = $1 AND operation_scope = $2 AND idempotency_key = $3 AND request_fingerprint = $4`,
  [actorId, scope, key, requestFingerprint, JSON.stringify(response)]);
}

async function lockCourseForTrainer(client: PoolClient, actor: Actor, courseRunId: string) {
  const course = await client.query<{ owner_user_id: string; progress_tracking_type: 'none' | 'online_video'; run_status: string; publication_status: string }>(`SELECT c.owner_user_id, cr.progress_tracking_type, cr.run_status, c.publication_status
    FROM course_runs cr JOIN courses c ON c.course_id = cr.course_id
    WHERE cr.course_run_id = $1 FOR UPDATE OF cr, c`, [courseRunId]);
  const row = course.rows[0];
  if (!row || row.owner_user_id !== actor.id) throw new ApiError(404, 'COURSE_NOT_FOUND', 'Course offering was not found.');
  if (row.progress_tracking_type !== 'online_video') throw new ApiError(409, 'COURSE_NOT_ONLINE_VIDEO', 'This course is not configured for hosted online video.');
  if (row.run_status === 'cancelled' || row.publication_status === 'archived') throw new ApiError(409, 'COURSE_NOT_VIDEO_EDITABLE', 'This course can no longer be changed.');
  return row;
}

function versionResponse(row: VideoVersion, hasOrderReferences = false) {
  return {
    id: row.course_video_version_id,
    versionNo: row.version_no,
    status: row.video_status,
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    width: row.width,
    height: row.height,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    isCurrent: row.is_current,
    hasOrderReferences,
    canRetry: row.video_status === 'queued' || (row.video_status === 'failed' && !isTerminalVideoFailure(row.failure_code)),
    canDelete: !hasOrderReferences && ['upload_pending', 'queued', 'failed', 'superseded'].includes(row.video_status),
    createdAt: row.created_at,
  };
}

async function videoSourceForTrainer(client: PoolClient, actor: Actor, courseRunId: string, versionId: string, lock = false) {
  const result = await client.query<VideoSourceRow>(`SELECT cv.course_video_version_id, cv.course_run_id, cv.source_asset_id, cv.video_status, cv.source_upload_id,
      cv.source_upload_part_size_bytes, cv.duration_seconds::text, cv.width, cv.height, cv.hls_master_key, cv.failure_code,
      cv.failure_message, cv.version_no, cv.is_current, cv.created_at, c.owner_user_id, c.publication_status, cr.run_status,
      cr.progress_tracking_type, asset.bucket_name, asset.object_key, asset.original_filename, asset.declared_content_type,
      asset.declared_byte_size::text, asset.asset_status, asset.upload_expires_at
    FROM course_video_versions cv
    JOIN course_delivery_assets asset ON asset.course_delivery_asset_id = cv.source_asset_id
    JOIN course_runs cr ON cr.course_run_id = cv.course_run_id
    JOIN courses c ON c.course_id = cr.course_id
    WHERE cv.course_run_id = $1 AND cv.course_video_version_id = $2${lock ? ' FOR UPDATE OF cv, asset, cr, c' : ''}`, [courseRunId, versionId]);
  const row = result.rows[0];
  if (!row || (row.owner_user_id !== actor.id && !actor.roles.includes('admin'))) throw new ApiError(404, 'VIDEO_VERSION_NOT_FOUND', 'Video version was not found.');
  return row;
}

export async function getCourseVideo(req: Request, res: Response) {
  requireHostedVideo();
  const actor = res.locals.actor as Actor;
  if (!actor.roles.includes('trainer') && !actor.roles.includes('admin')) throw new ApiError(403, 'VIDEO_ACCESS_DENIED', 'Trainer or Administrator access is required.');
  const courseRunId = parse(uuid, req.params.id);
  const result = await query<VideoVersion & { owner_user_id: string; run_status: string; publication_status: string; references: string }>(`SELECT cv.course_video_version_id, cv.course_run_id, cv.source_asset_id, cv.video_status, cv.source_upload_id,
      cv.source_upload_part_size_bytes, cv.duration_seconds::text, cv.width, cv.height, cv.hls_master_key, cv.failure_code,
      cv.failure_message, cv.version_no, cv.is_current, cv.created_at, c.owner_user_id, cr.run_status, c.publication_status,
      count(oi.order_item_id)::text AS references
    FROM course_runs cr JOIN courses c ON c.course_id = cr.course_id
    LEFT JOIN course_video_versions cv ON cv.course_run_id = cr.course_run_id
    LEFT JOIN order_items oi ON oi.course_video_version_id = cv.course_video_version_id
    WHERE cr.course_run_id = $1 GROUP BY cv.course_video_version_id, c.owner_user_id, cr.run_status, c.publication_status
    ORDER BY cv.version_no DESC NULLS LAST`, [courseRunId]);
  if (!result.rowCount || (result.rows[0].owner_user_id !== actor.id && !actor.roles.includes('admin'))) throw new ApiError(404, 'COURSE_NOT_FOUND', 'Course offering was not found.');
  const versions = result.rows.filter((row) => row.course_video_version_id).map((row) => versionResponse(row, Number(row.references) > 0));
  const reviewVersion = versions.find((row) => row.isCurrent) ?? versions.find((row) => row.status === 'ready') ?? null;
  const courseEditable = !['cancelled', 'archived'].includes(result.rows[0].run_status) && !['archived'].includes(result.rows[0].publication_status);
  return ok(res, {
    canUpload: actor.roles.includes('trainer') && result.rows[0].owner_user_id === actor.id && courseEditable && !versions.some((row) => ['upload_pending', 'queued', 'transcoding'].includes(row.status)),
    canSubmit: actor.roles.includes('trainer') && result.rows[0].owner_user_id === actor.id && result.rows[0].run_status === 'draft' && Boolean(reviewVersion?.status === 'ready'),
    reviewVersionId: reviewVersion?.id ?? null,
    versions,
  });
}

export async function createVideoUploadIntent(req: Request, res: Response) {
  requireHostedVideo();
  const actor = res.locals.actor as Actor;
  requireTrainer(actor);
  const courseRunId = parse(uuid, req.params.id);
  const input = validateVideoSource(parse(uploadInput, req.body), env.VIDEO_SOURCE_MAX_BYTES);
  const key = parse(idempotencyKey, req.get('idempotency-key'));
  const objectKey = createVideoSourceObjectKey(actor.id, courseRunId, input.filename);
  const uploadId = await startMultipartVideoUpload(env.R2_BUCKET_NAME, objectKey, input.mediaType);
  try {
    const response = await withTransaction(async (client) => {
      await assertTrainerOperational(client, actor.id);
      await lockCourseForTrainer(client, actor, courseRunId);
      const claimed = await claimIdempotency(client, actor.id, 'course-video-upload-intent', key, input);
      if (claimed.cached) return { body: claimed.cached, reused: true };
      const active = await client.query(`SELECT 1 FROM course_video_versions WHERE course_run_id = $1
        AND video_status IN ('upload_pending', 'queued', 'transcoding') FOR UPDATE`, [courseRunId]);
      if (active.rowCount) throw new ApiError(409, 'VIDEO_UPLOAD_IN_PROGRESS', 'Finish or remove the current video upload before starting another.');
      const asset = await client.query<{ course_delivery_asset_id: string }>(`INSERT INTO course_delivery_assets
        (course_run_id, owner_user_id, asset_purpose, bucket_name, object_key, original_filename, declared_content_type,
         declared_byte_size, asset_status, upload_expires_at)
        VALUES ($1, $2, 'video_source', $3, $4, $5, $6, $7, 'pending', now() + interval '24 hours')
        RETURNING course_delivery_asset_id`, [courseRunId, actor.id, env.R2_BUCKET_NAME, objectKey, input.filename, input.mediaType, input.sizeBytes]);
      const versionNo = await client.query<{ next_version_no: number }>(`SELECT COALESCE(MAX(version_no), 0)::int + 1 AS next_version_no
        FROM course_video_versions WHERE course_run_id = $1`, [courseRunId]);
      const version = await client.query<{ course_video_version_id: string }>(`INSERT INTO course_video_versions
        (course_run_id, source_asset_id, version_no, source_upload_id, source_upload_part_size_bytes)
        VALUES ($1, $2, $3, $4, $5) RETURNING course_video_version_id`,
      [courseRunId, asset.rows[0].course_delivery_asset_id, versionNo.rows[0].next_version_no, uploadId, VIDEO_PART_SIZE_BYTES]);
      const body = { videoVersionId: version.rows[0].course_video_version_id, partSizeBytes: VIDEO_PART_SIZE_BYTES };
      await finishIdempotency(client, actor.id, 'course-video-upload-intent', key, claimed.requestFingerprint, body);
      return { body, reused: false };
    });
    // A retried idempotency key creates no second durable version; abort its
    // just-created remote multipart upload before returning the stored result.
    if (response.reused) await abortMultipartVideoUpload(env.R2_BUCKET_NAME, objectKey, uploadId);
    return ok(res, response.body, response.reused ? 200 : 201);
  } catch (error) {
    await abortMultipartVideoUpload(env.R2_BUCKET_NAME, objectKey, uploadId);
    throw error;
  }
}

export async function listVideoMultipartParts(req: Request, res: Response) {
  requireHostedVideo();
  const actor = res.locals.actor as Actor;
  requireTrainer(actor);
  const courseRunId = parse(uuid, req.params.id);
  const versionId = parse(uuid, req.params.versionId);
  const version = await videoSourceForTrainer({ query } as PoolClient, actor, courseRunId, versionId);
  if (version.video_status !== 'upload_pending') return ok(res, { partSizeBytes: version.source_upload_part_size_bytes, parts: [], completed: true });
  if (!version.source_upload_id || version.upload_expires_at <= new Date()) throw new ApiError(410, 'UPLOAD_EXPIRED', 'This upload has expired. Cancel it and start again.');
  const parts = await listMultipartVideoParts(version.bucket_name, version.object_key, version.source_upload_id);
  return ok(res, { partSizeBytes: version.source_upload_part_size_bytes, parts, completed: false });
}

export async function signVideoMultipartPart(req: Request, res: Response) {
  requireHostedVideo();
  const actor = res.locals.actor as Actor;
  requireTrainer(actor);
  const courseRunId = parse(uuid, req.params.id);
  const versionId = parse(uuid, req.params.versionId);
  const input = parse(partInput, req.body);
  const version = await videoSourceForTrainer({ query } as PoolClient, actor, courseRunId, versionId);
  if (version.video_status !== 'upload_pending' || !version.source_upload_id || version.upload_expires_at <= new Date()) {
    throw new ApiError(410, 'UPLOAD_EXPIRED', 'This upload is no longer open.');
  }
  const expectedParts = Math.ceil(Number(version.declared_byte_size) / version.source_upload_part_size_bytes);
  if (input.partNumber > expectedParts) throw new ApiError(400, 'VIDEO_PART_INVALID', 'The requested upload part is outside this file.');
  return ok(res, await signMultipartVideoPart(version.bucket_name, version.object_key, version.source_upload_id, input.partNumber));
}

export async function completeVideoMultipart(req: Request, res: Response) {
  requireHostedVideo();
  const actor = res.locals.actor as Actor;
  requireTrainer(actor);
  const courseRunId = parse(uuid, req.params.id);
  const versionId = parse(uuid, req.params.versionId);
  const input = parse(completePartsInput, req.body);
  const key = parse(idempotencyKey, req.get('idempotency-key'));
  const response = await withTransaction(async (client) => {
    const row = await videoSourceForTrainer(client, actor, courseRunId, versionId, true);
    const claimed = await claimIdempotency(client, actor.id, 'course-video-multipart-complete', key, input);
    if (claimed.cached) return claimed.cached;
    if (row.video_status !== 'upload_pending' || !row.source_upload_id || row.upload_expires_at <= new Date()) {
      throw new ApiError(410, 'UPLOAD_EXPIRED', 'This upload is no longer open.');
    }
    // R2 multipart completion and the DB commit cannot be atomic. First check
    // the unique server-generated key so a retry can recover when R2 completed
    // but the prior database transaction rolled back.
    let completedObject = await findVideoSource(row.bucket_name, row.object_key);
    if (!completedObject) {
      const remote = await listMultipartVideoParts(row.bucket_name, row.object_key, row.source_upload_id);
      const expectedCount = Math.ceil(Number(row.declared_byte_size) / row.source_upload_part_size_bytes);
      const submitted = new Map(input.parts.map((part) => [part.partNumber, part.etag.replaceAll('"', '')]));
      if (submitted.size !== expectedCount || remote.length !== expectedCount || remote.some((part, index) =>
        part.partNumber !== index + 1 || part.sizeBytes !== Math.min(row.source_upload_part_size_bytes, Number(row.declared_byte_size) - index * row.source_upload_part_size_bytes)
          || submitted.get(part.partNumber) !== part.etag)) {
        throw new ApiError(409, 'VIDEO_PARTS_INVALID', 'All source parts must be uploaded once with their matching ETags.');
      }
      await completeMultipartVideoUpload(row.bucket_name, row.object_key, row.source_upload_id, input.parts);
      completedObject = await headVideoSource(row.bucket_name, row.object_key);
    }
    if (completedObject.contentLength !== Number(row.declared_byte_size)) {
      throw new ApiError(409, 'UPLOAD_OBJECT_MISMATCH', 'The uploaded source size does not match the upload intent.');
    }
    await client.query(`UPDATE course_delivery_assets SET asset_status = 'uploaded', uploaded_at = now(), updated_at = now()
      WHERE course_delivery_asset_id = $1 AND asset_status = 'pending'`, [row.source_asset_id]);
    const body = { videoVersionId: versionId, status: 'upload_pending' };
    await finishIdempotency(client, actor.id, 'course-video-multipart-complete', key, claimed.requestFingerprint, body);
    return body;
  });
  return ok(res, response);
}
async function queueVerifiedVideo(actor: Actor, courseRunId: string, versionId: string, key: string) {
  const queued = await withTransaction(async (client) => {
    const row = await videoSourceForTrainer(client, actor, courseRunId, versionId, true);
    const claimed = await claimIdempotency(client, actor.id, 'course-video-verify', key, { versionId });
    if (claimed.cached) return { body: claimed.cached, enqueue: claimed.cached.status === 'queued' };
    if (row.video_status === 'queued' || row.video_status === 'transcoding' || row.video_status === 'ready') {
      const body = { videoVersionId: versionId, status: row.video_status };
      await finishIdempotency(client, actor.id, 'course-video-verify', key, claimed.requestFingerprint, body);
      return { body, enqueue: row.video_status === 'queued' };
    }
    if (row.video_status !== 'upload_pending' || row.asset_status !== 'uploaded') throw new ApiError(409, 'VIDEO_UPLOAD_NOT_COMPLETE', 'Complete the multipart upload before requesting processing.');
    const headed = await headVideoSource(row.bucket_name, row.object_key);
    if (headed.contentLength !== Number(row.declared_byte_size)) throw new ApiError(409, 'UPLOAD_OBJECT_MISMATCH', 'The uploaded source size does not match the upload intent.');
    await client.query(`UPDATE course_delivery_assets SET asset_status = 'ready', verified_content_type = declared_content_type,
      verified_byte_size = declared_byte_size, etag = $2, verified_at = now(), updated_at = now()
      WHERE course_delivery_asset_id = $1`, [row.source_asset_id, headed.etag ?? null]);
    await client.query(`UPDATE course_video_versions SET video_status = 'queued', queued_at = now(), failure_code = NULL,
      failure_message = NULL, updated_at = now() WHERE course_video_version_id = $1`, [versionId]);
    const body = { videoVersionId: versionId, status: 'queued' };
    await finishIdempotency(client, actor.id, 'course-video-verify', key, claimed.requestFingerprint, body);
    return { body, enqueue: true };
  });
  if (queued.enqueue) await enqueueVideoTranscode(versionId);
  return queued.body;
}

export async function completeVideoUpload(req: Request, res: Response) {
  requireHostedVideo();
  const actor = res.locals.actor as Actor;
  requireTrainer(actor);
  return ok(res, await queueVerifiedVideo(actor, parse(uuid, req.params.id), parse(uuid, req.params.versionId), parse(idempotencyKey, req.get('idempotency-key'))));
}

async function retryVideoForActor(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const courseRunId = parse(uuid, req.params.id);
  const versionId = parse(uuid, req.params.versionId);
  const key = parse(idempotencyKey, req.get('idempotency-key'));
  const response = await withTransaction(async (client) => {
    const row = await videoSourceForTrainer(client, actor, courseRunId, versionId, true);
    const claimed = await claimIdempotency(client, actor.id, 'course-video-retry', key, { versionId });
    if (claimed.cached) return { body: claimed.cached, enqueue: claimed.cached.status === 'queued' };
    if (!['failed', 'queued'].includes(row.video_status) || row.asset_status !== 'ready' || isTerminalVideoFailure(row.failure_code)) {
      throw new ApiError(409, 'VIDEO_RETRY_NOT_ALLOWED', 'This video version cannot be retried.');
    }
    await client.query(`UPDATE course_video_versions SET video_status = 'queued', queued_at = now(), failure_code = NULL,
      failure_message = NULL, updated_at = now() WHERE course_video_version_id = $1`, [versionId]);
    const body = { videoVersionId: versionId, status: 'queued' };
    await finishIdempotency(client, actor.id, 'course-video-retry', key, claimed.requestFingerprint, body);
    return { body, enqueue: true };
  });
  if (response.enqueue) await enqueueVideoTranscode(versionId);
  return ok(res, response.body);
}

export async function retryVideo(req: Request, res: Response) {
  requireHostedVideo();
  requireTrainer(res.locals.actor as Actor);
  return retryVideoForActor(req, res);
}

export async function retryVideoForAdmin(req: Request, res: Response) {
  requireHostedVideo();
  const actor = res.locals.actor as Actor;
  if (!actor.roles.includes('admin')) throw new ApiError(403, 'ADMIN_ROLE_REQUIRED', 'Administrator access is required.');
  return retryVideoForActor(req, res);
}
export async function abortVideoMultipart(req: Request, res: Response) {
  requireHostedVideo();
  const actor = res.locals.actor as Actor;
  requireTrainer(actor);
  const courseRunId = parse(uuid, req.params.id);
  const versionId = parse(uuid, req.params.versionId);
  const version = await withTransaction((client) => videoSourceForTrainer(client, actor, courseRunId, versionId, true));
  if (version.video_status !== 'upload_pending' || !version.source_upload_id) return ok(res, { videoVersionId: versionId, status: version.video_status });
  await abortMultipartVideoUpload(version.bucket_name, version.object_key, version.source_upload_id);
  await withTransaction(async (client) => {
    await client.query(`UPDATE course_delivery_assets SET asset_status = 'delete_pending', updated_at = now()
      WHERE course_delivery_asset_id = $1 AND asset_status = 'pending'`, [version.source_asset_id]);
    await client.query(`UPDATE course_video_versions SET video_status = 'delete_pending', updated_at = now() WHERE course_video_version_id = $1`, [versionId]);
  });
  return ok(res, { videoVersionId: versionId, status: 'delete_pending' });
}

export async function deleteVideoVersion(req: Request, res: Response) {
  requireHostedVideo();
  const actor = res.locals.actor as Actor;
  requireTrainer(actor);
  const courseRunId = parse(uuid, req.params.id);
  const versionId = parse(uuid, req.params.versionId);
  const version = await withTransaction(async (client) => {
    const row = await videoSourceForTrainer(client, actor, courseRunId, versionId, true);
    const references = await client.query('SELECT 1 FROM order_items WHERE course_video_version_id = $1 LIMIT 1', [versionId]);
    if (references.rowCount) throw new ApiError(409, 'VIDEO_VERSION_REFERENCED', 'This video version belongs to an existing order and cannot be deleted.');
    if (!['upload_pending', 'queued', 'failed', 'superseded'].includes(row.video_status)) throw new ApiError(409, 'VIDEO_DELETE_NOT_ALLOWED', 'This video version cannot be deleted now.');
    await client.query(`UPDATE course_video_versions SET video_status = 'delete_pending', is_current = false, updated_at = now()
      WHERE course_video_version_id = $1`, [versionId]);
    await client.query(`UPDATE course_delivery_assets SET asset_status = 'delete_pending', updated_at = now()
      WHERE course_delivery_asset_id = $1`, [row.source_asset_id]);
    return row;
  });
  if (version.source_upload_id && version.video_status === 'upload_pending') {
    await abortMultipartVideoUpload(version.bucket_name, version.object_key, version.source_upload_id);
  }
  // Only the Worker holds credentials for both source and HLS buckets. It
  // performs the idempotent physical deletion and changes this state to
  // deleted only after every associated object has been removed.
  return ok(res, { videoVersionId: versionId, status: 'delete_pending' }, 202);
}
function signPlaybackToken(value: Record<string, unknown>) {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = createHmac('sha256', env.VIDEO_PLAYBACK_TOKEN_SECRET).update(`v1.${payload}`).digest('base64url');
  return `v1.${payload}.${signature}`;
}

function gatewayManifestUrl(versionId: string, masterKey: string) {
  const origin = env.VIDEO_PLAYBACK_GATEWAY_ORIGIN.replace(/\/$/, '');
  const root = `course-video-hls/${versionId}/`;
  if (!masterKey.startsWith(root)) throw new ApiError(503, 'VIDEO_OUTPUT_INVALID', 'The stored video output path is invalid.');
  const assetPath = masterKey.slice(root.length).split('/').map(encodeURIComponent).join('/');
  return `${origin}/v1/hls/${encodeURIComponent(versionId)}/${assetPath}`;
}

async function createPlaybackSessionForVersion(client: PoolClient, actor: Actor, orderItemId: string, versionId: string, preview = false) {
  const row = await client.query<{ order_item_id: string; course_video_version_id: string; duration_seconds: string; hls_master_key: string; fulfilment_status: string; buyer_user_id: string }>(`SELECT oi.order_item_id, oi.course_video_version_id,
      cv.duration_seconds::text, cv.hls_master_key, oi.fulfilment_status, o.buyer_user_id
    FROM order_items oi
    JOIN orders o ON o.order_id = oi.order_id
    JOIN users buyer ON buyer.user_id = o.buyer_user_id AND buyer.account_status = 'active'
    JOIN course_enrolments ce ON ce.order_item_id = oi.order_item_id
      AND ce.learner_user_id = o.buyer_user_id
      AND ce.enrolment_status IN ('active', 'confirmed', 'in_progress')
    JOIN course_video_versions cv ON cv.course_video_version_id = oi.course_video_version_id
    WHERE oi.order_item_id = $1 AND oi.course_video_version_id = $2 AND cv.video_status IN ('ready', 'superseded')
    FOR SHARE OF oi, ce, cv, buyer`, [orderItemId, versionId]);
  const access = row.rows[0];
  if (!access || (!preview && (access.buyer_user_id !== actor.id || !['fulfilled', 'paid'].includes(access.fulfilment_status)))) {
    throw new ApiError(403, 'PLAYBACK_UNAUTHORISED', 'This purchase is not authorised to play the requested video.');
  }
  const expiresAt = new Date(Date.now() + env.VIDEO_PLAYBACK_TTL_SECONDS * 1000);
  const sessionId = randomUUID();
  const durationSeconds = Number(access.duration_seconds);
  const resume = await client.query<{ resume_at: string | null }>(`SELECT MAX(interval_end_seconds)::text AS resume_at
    FROM course_video_watch_intervals WHERE order_item_id = $1 AND course_video_version_id = $2`, [orderItemId, versionId]);
  await client.query(`INSERT INTO course_video_progress_sessions
    (order_item_id, course_video_version_id, session_id, playback_expires_at, session_status, last_sequence, last_seen_at)
    VALUES ($1, $2, $3, $4, 'active', 0, now())`, [orderItemId, versionId, sessionId, expiresAt]);
  const token = signPlaybackToken({ sub: actor.id, orderItemId, videoVersionId: versionId, sessionId, exp: Math.floor(expiresAt.getTime() / 1000), scope: preview ? 'preview' : 'play' });
  return {
    sessionId, videoVersionId: versionId, manifestUrl: gatewayManifestUrl(versionId, row.rows[0].hls_master_key), expiresAt: expiresAt.toISOString(),
    durationSeconds, resumeAt: Math.min(durationSeconds, Math.max(0, Number(resume.rows[0]?.resume_at ?? 0))),
    authorization: { type: 'header' as const, token },
  };
}

export async function createPlaybackSession(req: Request, res: Response) {
  requireHostedVideo();
  const actor = res.locals.actor as Actor;
  const orderItemId = parse(uuid, req.params.orderItemId);
  const session = await withTransaction(async (client) => {
    const version = await client.query<{ course_video_version_id: string | null }>('SELECT course_video_version_id FROM order_items WHERE order_item_id = $1', [orderItemId]);
    if (!version.rows[0]?.course_video_version_id) throw new ApiError(409, 'VIDEO_NOT_READY', 'This order does not have a ready hosted video.');
    return createPlaybackSessionForVersion(client, actor, orderItemId, version.rows[0].course_video_version_id);
  });
  res.set('Cache-Control', 'private, no-store');
  return ok(res, session, 201);
}

export async function createPreviewPlaybackSession(req: Request, res: Response) {
  requireHostedVideo();
  const actor = res.locals.actor as Actor;
  const courseRunId = parse(uuid, req.params.id);
  const versionId = parse(uuid, req.params.versionId);
  // Preview sessions use a synthetic read-only binding with a durable UUID
  // cannot be faked: administrators must have authenticated MFA before route entry.
  const session = await withTransaction(async (client) => {
    const version = await client.query<{ course_video_version_id: string; duration_seconds: string; hls_master_key: string }>(`SELECT course_video_version_id, duration_seconds::text, hls_master_key
      FROM course_video_versions WHERE course_run_id = $1 AND course_video_version_id = $2 AND video_status = 'ready' FOR SHARE`, [courseRunId, versionId]);
    if (!version.rowCount) throw new ApiError(404, 'VIDEO_VERSION_NOT_FOUND', 'Ready video version was not found.');
    const expiresAt = new Date(Date.now() + env.VIDEO_PLAYBACK_TTL_SECONDS * 1000);
    const sessionId = randomUUID();
    const token = signPlaybackToken({ sub: actor.id, videoVersionId: versionId, sessionId, exp: Math.floor(expiresAt.getTime() / 1000), scope: 'preview' });
    return { sessionId, videoVersionId: versionId, manifestUrl: gatewayManifestUrl(versionId, version.rows[0].hls_master_key), expiresAt: expiresAt.toISOString(), durationSeconds: Number(version.rows[0].duration_seconds), resumeAt: 0, authorization: { type: 'header' as const, token } };
  });
  res.set('Cache-Control', 'private, no-store');
  return ok(res, session, 201);
}

async function progressFor(client: PoolClient, orderItemId: string, versionId: string, durationSeconds: number) {
  const intervals = await client.query<{ interval_start_seconds: string; interval_end_seconds: string }>(`SELECT interval_start_seconds::text, interval_end_seconds::text
    FROM course_video_watch_intervals WHERE order_item_id = $1 AND course_video_version_id = $2 FOR UPDATE`, [orderItemId, versionId]);
  const mapped = intervals.rows.map((row) => ({ startSeconds: Number(row.interval_start_seconds), endSeconds: Number(row.interval_end_seconds) }));
  const watched = uniqueWatchedSeconds(mapped, durationSeconds);
  return { intervals: mapped, watched };
}

export async function recordVideoProgress(req: Request, res: Response) {
  requireHostedVideo();
  const actor = res.locals.actor as Actor;
  const orderItemId = parse(uuid, req.params.orderItemId);
  const input = parse(heartbeatInput, req.body) as Heartbeat & { sessionId: string };
  const progress = await withTransaction(async (client) => {
    // Every heartbeat and refund request locks the order item first. This keeps
    // an eligibility snapshot from racing an accepted interval write.
    const order = await client.query<{ course_video_version_id: string | null }>(`SELECT oi.course_video_version_id
      FROM order_items oi
      JOIN orders o ON o.order_id = oi.order_id
      JOIN course_enrolments ce ON ce.order_item_id = oi.order_item_id
        AND ce.learner_user_id = o.buyer_user_id
        AND ce.enrolment_status IN ('active', 'confirmed', 'in_progress')
      WHERE oi.order_item_id = $1 AND o.buyer_user_id = $2 AND oi.fulfilment_status IN ('fulfilled', 'paid')
      FOR UPDATE OF oi`, [orderItemId, actor.id]);
    const boundVersionId = order.rows[0]?.course_video_version_id;
    if (!boundVersionId) throw new ApiError(403, 'PLAYBACK_UNAUTHORISED', 'This playback session is not authorised.');

    const session = await client.query<{ course_video_version_id: string; session_status: string; playback_expires_at: Date | null; last_sequence: number; last_position_seconds: string | null; last_playback_rate: string | null; last_client_monotonic_ms: string | null; last_event: PlaybackEvent | null; last_heartbeat_at: Date | null; server_received_at: Date }>(`SELECT
      ps.course_video_version_id, ps.session_status, ps.playback_expires_at, ps.last_sequence,
      ps.last_position_seconds::text, ps.last_playback_rate::text, ps.last_client_monotonic_ms::text,
      ps.last_event, ps.last_heartbeat_at, clock_timestamp() AS server_received_at
      FROM course_video_progress_sessions ps
      WHERE ps.order_item_id = $1 AND ps.session_id = $2
      FOR UPDATE`, [orderItemId, input.sessionId]);
    const current = session.rows[0];
    if (!current || current.course_video_version_id !== boundVersionId) {
      throw new ApiError(403, 'PLAYBACK_UNAUTHORISED', 'This playback session is not authorised.');
    }
    if (current.session_status !== 'active' || !current.playback_expires_at || current.playback_expires_at <= new Date()) {
      await client.query(`UPDATE course_video_progress_sessions SET session_status = 'expired', updated_at = now()
        WHERE order_item_id = $1 AND session_id = $2`, [orderItemId, input.sessionId]);
      throw new ApiError(401, 'PLAYBACK_EXPIRED', 'This playback authorisation has expired.');
    }
    const video = await client.query<{ duration_seconds: string; enrolment_id: string; access_progress_id: string | null }>(`SELECT cv.duration_seconds::text, ce.enrolment_id, cap.access_progress_id
      FROM course_video_versions cv
      JOIN course_enrolments ce ON ce.order_item_id = $1
        AND ce.enrolment_status IN ('active', 'confirmed', 'in_progress')
      LEFT JOIN course_access_progress cap ON cap.enrolment_id = ce.enrolment_id
      WHERE cv.course_video_version_id = $2 AND cv.video_status IN ('ready', 'superseded')
      FOR UPDATE OF cv, ce`, [orderItemId, current.course_video_version_id]);
    if (!video.rowCount) throw new ApiError(409, 'VIDEO_NOT_READY', 'The bound video is not available.');
    const durationSeconds = Number(video.rows[0].duration_seconds);
    const previous = current.last_event === null || current.last_position_seconds === null || current.last_playback_rate === null
      || current.last_client_monotonic_ms === null || current.last_heartbeat_at === null
      ? null : {
        sequence: current.last_sequence,
        event: current.last_event,
        positionSeconds: Number(current.last_position_seconds),
        playbackRate: Number(current.last_playback_rate),
        clientMonotonicMs: Number(current.last_client_monotonic_ms),
        serverReceivedAt: current.last_heartbeat_at,
      };
    let interval;
    try {
      interval = intervalFromHeartbeat(previous, input, durationSeconds, current.server_received_at, env.VIDEO_HEARTBEAT_MAX_GAP_SECONDS);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'HEARTBEAT_INVALID';
      throw new ApiError(code === 'HEARTBEAT_OUT_OF_BOUNDS' ? 409 : 400, code, 'The playback observation could not be confirmed.');
    }
    const before = await progressFor(client, orderItemId, current.course_video_version_id, durationSeconds);
    if (interval) await client.query(`INSERT INTO course_video_watch_intervals
      (order_item_id, course_video_version_id, source_session_id, interval_start_seconds, interval_end_seconds)
      VALUES ($1, $2, $3, $4, $5)`, [orderItemId, current.course_video_version_id, input.sessionId, interval.startSeconds, interval.endSeconds]);
    const all = interval ? [...before.intervals, { startSeconds: interval.startSeconds, endSeconds: interval.endSeconds }] : before.intervals;
    const watched = uniqueWatchedSeconds(all, durationSeconds);
    if (input.sequence > current.last_sequence) {
      await client.query(`UPDATE course_video_progress_sessions SET last_sequence = $3, last_position_seconds = $4,
        last_playback_rate = $5, last_client_monotonic_ms = $6, last_event = $7, last_heartbeat_at = $8,
        last_seen_at = $8, reported_watched_seconds = GREATEST(reported_watched_seconds, $9),
        accepted_watched_seconds = GREATEST(accepted_watched_seconds, $10), updated_at = $8
        WHERE order_item_id = $1 AND session_id = $2`, [orderItemId, input.sessionId, input.sequence, input.positionSeconds,
        input.playbackRate, input.clientMonotonicMs, input.event, current.server_received_at, input.positionSeconds, watched]);
    }
    const ratio = durationSeconds ? watched / durationSeconds : 0;
    if (video.rows[0].access_progress_id) {
      await client.query(`UPDATE course_access_progress SET watched_seconds = $2, total_seconds = $3, watch_percent = $4,
        first_started_at = COALESCE(first_started_at, now()), last_watched_at = now(), updated_at = now()
        WHERE access_progress_id = $1`, [video.rows[0].access_progress_id, watched, durationSeconds, ratio * 100]);
    }
    return { uniqueContentWatchedSeconds: watched, durationSeconds, watchedRatio: ratio };
  });
  return ok(res, { progress });
}
export async function listVideoOperations(_req: Request, res: Response) {
  requireHostedVideo();
  const [counts, versions] = await Promise.all([
    query<{ queued: string; failed: string; pending_cleanup: string }>(`SELECT
      count(*) FILTER (WHERE video_status IN ('queued', 'transcoding'))::text AS queued,
      count(*) FILTER (WHERE video_status = 'failed')::text AS failed,
      count(*) FILTER (WHERE video_status = 'delete_pending')::text AS pending_cleanup
      FROM course_video_versions`),
    query<VideoVersion>(`SELECT course_video_version_id, course_run_id, source_asset_id, video_status, source_upload_id,
      source_upload_part_size_bytes, duration_seconds::text, width, height, hls_master_key, failure_code, failure_message,
      version_no, is_current, created_at FROM course_video_versions
      WHERE video_status IN ('queued', 'transcoding', 'failed', 'delete_pending') ORDER BY updated_at DESC LIMIT 100`),
  ]);
  const count = counts.rows[0];
  return ok(res, {
    counts: { queued: Number(count.queued), failed: Number(count.failed), orphanCandidates: 0, pendingCleanup: Number(count.pending_cleanup) },
    jobs: versions.rows.filter((row) => row.video_status !== 'delete_pending').map((row) => {
      const terminal = row.video_status === 'failed' && isTerminalVideoFailure(row.failure_code);
      return { id: row.course_video_version_id, videoVersionId: row.course_video_version_id,
        courseRunId: row.course_run_id, status: row.video_status === 'transcoding' ? 'running' : terminal ? 'dead' : row.video_status === 'failed' ? 'retryable_failed' : 'queued',
        updatedAt: row.created_at, canRetry: row.video_status === 'queued' || (row.video_status === 'failed' && !terminal) };
    }),
    cleanupTasks: versions.rows.filter((row) => row.video_status === 'delete_pending').map((row) => ({ videoVersionId: row.course_video_version_id, status: 'pending' })),
  });
}

// The Docker worker calls this after ffprobe and HLS publication. It is not an
// HTTP handler so it can be reused by a queue consumer with a worker-only DB role.
export async function markVideoReady(client: PoolClient, input: { videoVersionId: string; durationSeconds: number; width: number; height: number; bucketName: string; outputPrefix: string; masterKey: string; thumbnailKey?: string }) {
  if (!(input.durationSeconds > 0 && input.durationSeconds <= 14400) || !Number.isInteger(input.width) || input.width <= 0 || !Number.isInteger(input.height) || input.height <= 0) {
    throw new ApiError(409, 'VIDEO_INVALID_SOURCE', 'ffprobe did not return a supported video duration and dimensions.');
  }
  const pending = await client.query<{ course_run_id: string }>(`SELECT course_run_id FROM course_video_versions
    WHERE course_video_version_id = $1 AND video_status IN ('queued', 'transcoding') FOR UPDATE`, [input.videoVersionId]);
  if (!pending.rowCount) throw new ApiError(409, 'VIDEO_STATE_CONFLICT', 'Video is no longer awaiting processing.');
  // Clear the partial current-version index first; old orders continue to use
  // their immutable superseded version and its existing HLS objects.
  await client.query(`UPDATE course_video_versions SET video_status = 'superseded', is_current = false, updated_at = now()
    WHERE course_run_id = $1 AND course_video_version_id <> $2 AND is_current`, [pending.rows[0].course_run_id, input.videoVersionId]);
  await client.query(`UPDATE course_video_versions SET video_status = 'ready', is_current = true,
    duration_seconds = $2, width = $3, height = $4, hls_bucket_name = $5, hls_output_prefix = $6, hls_master_key = $7,
    thumbnail_key = $8, ready_at = now(), failure_code = NULL, failure_message = NULL, updated_at = now()
    WHERE course_video_version_id = $1`,
  [input.videoVersionId, input.durationSeconds, input.width, input.height, input.bucketName, input.outputPrefix, input.masterKey, input.thumbnailKey ?? null]);
  await client.query(`UPDATE course_runs SET total_duration_seconds = $2 WHERE course_run_id = $1`, [pending.rows[0].course_run_id, Math.ceil(input.durationSeconds)]);
}
