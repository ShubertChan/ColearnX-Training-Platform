import 'dotenv/config';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { PgBoss, type JobWithMetadata } from 'pg-boss';
import { Pool } from 'pg';

const execFile = promisify(execFileCallback);
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};
const databaseUrl = required('VIDEO_WORKER_DATABASE_URL');
const accountId = required('R2_ACCOUNT_ID');
const accessKeyId = required('R2_ACCESS_KEY_ID');
const secretAccessKey = required('R2_SECRET_ACCESS_KEY');
const sourceBucket = required('R2_BUCKET_NAME');
const hlsBucket = required('VIDEO_HLS_BUCKET_NAME');
const queueDatabaseUrl = process.env.VIDEO_QUEUE_DATABASE_URL || databaseUrl;
const pool = new Pool({ connectionString: databaseUrl, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
const storage = new S3Client({ region: process.env.R2_REGION || 'auto', endpoint: `https://${accountId}.r2.cloudflarestorage.com`, credentials: { accessKeyId, secretAccessKey } });
const queue = new PgBoss({ connectionString: queueDatabaseUrl, schema: 'pgboss', migrate: false, createSchema: false });
const queueName = 'course-video.transcode';
const workerConcurrency = Number(process.env.VIDEO_WORKER_CONCURRENCY || 1);
if (!Number.isInteger(workerConcurrency) || workerConcurrency < 1 || workerConcurrency > 8) {
  throw new Error('VIDEO_WORKER_CONCURRENCY must be an integer between 1 and 8.');
}

type Source = { course_video_version_id: string; course_run_id: string; bucket_name: string; object_key: string };
type Probe = { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
type PendingDelete = Source & { source_asset_id: string; hls_bucket_name: string | null; hls_output_prefix: string | null };

async function run(command: string, args: string[]) {
  await execFile(command, args, { maxBuffer: 1024 * 1024 });
}

function stagingPrefix(videoVersionId: string) {
  return `course-video-staging/${videoVersionId}`;
}

function finalPrefix(videoVersionId: string) {
  return `course-video-hls/${videoVersionId}`;
}

function outputContentType(name: string) {
  if (name.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (name.endsWith('.ts')) return 'video/mp2t';
  if (name.endsWith('.jpg')) return 'image/jpeg';
  return 'application/octet-stream';
}

async function deletePrefix(bucket: string, prefix: string) {
  let token: string | undefined;
  do {
    const listed = await storage.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix.replace(/\/$/, '')}/`, ContinuationToken: token }));
    const objects = (listed.Contents ?? []).flatMap((entry) => entry.Key ? [{ Key: entry.Key }] : []);
    if (objects.length) await storage.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);
}

async function uploadOutput(directory: string, prefix: string) {
  const names: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(m3u8|ts|jpg)$/i.test(entry.name)) continue;
    const key = `${prefix}/${entry.name}`;
    await storage.send(new PutObjectCommand({ Bucket: hlsBucket, Key: key, Body: createReadStream(join(directory, entry.name)), ContentType: outputContentType(entry.name) }));
    names.push(entry.name);
  }
  return names;
}

async function verifyRemoteOutput(prefix: string, names: string[]) {
  const expected = new Set(names.map((name) => `${prefix}/${name}`));
  let token: string | undefined;
  do {
    const listed = await storage.send(new ListObjectsV2Command({
      Bucket: hlsBucket,
      Prefix: `${prefix.replace(/\/$/, '')}/`,
      ContinuationToken: token,
    }));
    for (const object of listed.Contents ?? []) {
      if (object.Key && expected.has(object.Key) && (object.Size ?? 0) > 0) expected.delete(object.Key);
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);
  if (expected.size) throw new Error('HLS_OUTPUT_INVALID');
}

async function probe(input: string) {
  const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', input], { maxBuffer: 1024 * 1024 });
  const info = JSON.parse(stdout) as Probe;
  const duration = Number(info.format?.duration);
  const video = info.streams?.find((stream) => stream.codec_type === 'video');
  if (!Number.isFinite(duration) || duration <= 0 || duration > 14400 || !video?.width || !video.height) throw new Error('VIDEO_INVALID_SOURCE');
  return { duration, width: video.width, height: video.height };
}

async function validateHls(output: string, sourceDuration: number) {
  const playlist = await readFile(join(output, 'master.m3u8'), 'utf8');
  if (!playlist.startsWith('#EXTM3U')) throw new Error('HLS_OUTPUT_INVALID');
  const references = playlist.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const files = new Set((await readdir(output, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name));
  if (!references.length || references.some((name) => !/^[a-zA-Z0-9._-]+\.ts$/.test(name) || !files.has(name))) throw new Error('HLS_OUTPUT_INVALID');
  const playlistDuration = [...playlist.matchAll(/#EXTINF:([0-9.]+)/g)].reduce((total, match) => total + Number(match[1]), 0);
  if (!Number.isFinite(playlistDuration) || playlistDuration <= 0 || Math.abs(playlistDuration - sourceDuration) > Math.max(2, sourceDuration * 0.1)) {
    throw new Error('HLS_OUTPUT_INVALID');
  }
  const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', join(output, 'master.m3u8')], { maxBuffer: 1024 * 1024 });
  const decodedDuration = Number((JSON.parse(stdout) as Probe).format?.duration);
  if (!Number.isFinite(decodedDuration) || decodedDuration <= 0) throw new Error('HLS_OUTPUT_INVALID');
}

async function loadAndClaim(videoVersionId: string): Promise<Source | null> {
  const result = await pool.query<Source>(`UPDATE course_video_versions cv SET video_status = 'transcoding', transcoding_started_at = now(), updated_at = now()
    FROM course_delivery_assets asset
    WHERE cv.course_video_version_id = $1 AND cv.source_asset_id = asset.course_delivery_asset_id
      AND cv.video_status IN ('queued', 'transcoding')
    RETURNING cv.course_video_version_id, cv.course_run_id, asset.bucket_name, asset.object_key`, [videoVersionId]);
  return result.rows[0] ?? null;
}

async function markReady(source: Source, metadata: { duration: number; width: number; height: number }, prefix: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ course_run_id: string }>(`SELECT course_run_id FROM course_video_versions
      WHERE course_video_version_id = $1 AND video_status = 'transcoding' FOR UPDATE`, [source.course_video_version_id]);
    if (!current.rowCount) { await client.query('ROLLBACK'); return; }
    // Clear the partial unique index before promoting the replacement version.
    await client.query(`UPDATE course_video_versions SET video_status = 'superseded', is_current = false, updated_at = now()
      WHERE course_run_id = $1 AND course_video_version_id <> $2 AND is_current`, [source.course_run_id, source.course_video_version_id]);
    await client.query(`UPDATE course_video_versions SET video_status = 'ready', is_current = true, duration_seconds = $2,
      width = $3, height = $4, hls_bucket_name = $5, hls_output_prefix = $6, hls_master_key = $7, thumbnail_key = $8,
      ready_at = now(), failure_code = NULL, failure_message = NULL, updated_at = now()
      WHERE course_video_version_id = $1`, [source.course_video_version_id, metadata.duration, metadata.width, metadata.height, hlsBucket, prefix, `${prefix}/master.m3u8`, `${prefix}/thumbnail.jpg`]);
    await client.query('UPDATE course_runs SET total_duration_seconds = $2 WHERE course_run_id = $1', [source.course_run_id, Math.ceil(metadata.duration)]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function failureCode(error: unknown) {
  return error instanceof Error && error.message === 'VIDEO_INVALID_SOURCE' ? 'VIDEO_INVALID_SOURCE' : 'TRANSCODE_FAILED';
}

async function recordFailure(videoVersionId: string, error: unknown, terminal: boolean) {
  const code = failureCode(error);
  await pool.query(`UPDATE course_video_versions SET video_status = CASE WHEN $3 THEN 'failed' ELSE 'queued' END,
    queued_at = CASE WHEN $3 THEN queued_at ELSE now() END,
    failed_at = CASE WHEN $3 THEN now() ELSE NULL END,
    failure_code = $2,
    failure_message = CASE WHEN $2 = 'VIDEO_INVALID_SOURCE' THEN 'ffprobe did not recognise a supported video within the 4-hour limit.' ELSE 'Processing failed. You may retry this version.' END,
    updated_at = now() WHERE course_video_version_id = $1 AND video_status = 'transcoding'`, [videoVersionId, code, terminal]);
}

async function transcode(videoVersionId: string, retryCount: number, retryLimit: number) {
  const source = await loadAndClaim(videoVersionId);
  if (!source) return;
  const work = await mkdtemp(join(tmpdir(), 'colearnx-video-'));
  const staged = stagingPrefix(source.course_video_version_id);
  const published = finalPrefix(source.course_video_version_id);
  try {
    const input = join(work, 'source');
    const output = join(work, 'hls');
    const object = await storage.send(new GetObjectCommand({ Bucket: source.bucket_name || sourceBucket, Key: source.object_key }));
    if (!object.Body) throw new Error('SOURCE_NOT_FOUND');
    await pipeline(object.Body as NodeJS.ReadableStream, createWriteStream(input));
    const metadata = await probe(input);
    await mkdir(output, { recursive: true });
    await run('ffmpeg', ['-y', '-i', input, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-hls_time', '6', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments', '-hls_segment_filename', join(output, 'segment_%05d.ts'), join(output, 'master.m3u8')]);
    await run('ffmpeg', ['-y', '-ss', '1', '-i', input, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '3', join(output, 'thumbnail.jpg')]);
    await validateHls(output, metadata.duration);

    // Staging is never referenced by a ready row. Validate locally before and
    // after its upload, then publish the same verified output to the immutable
    // version prefix. A partial final upload remains unreachable until ready.
    await deletePrefix(hlsBucket, staged);
    const stagedFiles = await uploadOutput(output, staged);
    if (!stagedFiles.includes('master.m3u8') || !stagedFiles.includes('thumbnail.jpg')) throw new Error('HLS_OUTPUT_INVALID');
    await verifyRemoteOutput(staged, stagedFiles);
    await deletePrefix(hlsBucket, published);
    const publishedFiles = await uploadOutput(output, published);
    if (!publishedFiles.includes('master.m3u8') || !publishedFiles.includes('thumbnail.jpg')) throw new Error('HLS_OUTPUT_INVALID');
    await verifyRemoteOutput(published, publishedFiles);
    await markReady(source, metadata, published);
  } catch (error) {
    const terminal = failureCode(error) === 'VIDEO_INVALID_SOURCE' || retryCount >= retryLimit;
    await recordFailure(videoVersionId, error, terminal);
    // Retryable failures return the version to queued before pg-boss retries;
    // permanent or exhausted work is visible to the trainer as failed.
    if (!terminal) throw error;
  } finally {
    await deletePrefix(hlsBucket, staged).catch(() => undefined);
    await rm(work, { recursive: true, force: true });
  }
}

async function cleanupDeletePending() {
  const candidates = await pool.query<PendingDelete>(`SELECT cv.course_video_version_id, cv.course_run_id, cv.source_asset_id,
    asset.bucket_name, asset.object_key, cv.hls_bucket_name, cv.hls_output_prefix
    FROM course_video_versions cv JOIN course_delivery_assets asset ON asset.course_delivery_asset_id = cv.source_asset_id
    WHERE cv.video_status = 'delete_pending' ORDER BY cv.updated_at ASC LIMIT 25`);
  for (const candidate of candidates.rows) {
    try {
      await storage.send(new DeleteObjectCommand({ Bucket: candidate.bucket_name || sourceBucket, Key: candidate.object_key }));
      if (candidate.hls_output_prefix) await deletePrefix(candidate.hls_bucket_name || hlsBucket, candidate.hls_output_prefix);
      await deletePrefix(hlsBucket, stagingPrefix(candidate.course_video_version_id));
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query(`SELECT 1 FROM course_video_versions WHERE course_video_version_id = $1 AND video_status = 'delete_pending' FOR UPDATE`, [candidate.course_video_version_id]);
        if (locked.rowCount) {
          await client.query(`UPDATE course_delivery_assets SET asset_status = 'deleted', deleted_at = now(), updated_at = now()
            WHERE course_delivery_asset_id = $1 AND asset_status = 'delete_pending'`, [candidate.source_asset_id]);
          await client.query(`UPDATE course_video_versions SET video_status = 'deleted', deleted_at = now(), updated_at = now()
            WHERE course_video_version_id = $1 AND video_status = 'delete_pending'`, [candidate.course_video_version_id]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('video cleanup failed', { videoVersionId: candidate.course_video_version_id, error });
    }
  }
}

await cleanupDeletePending();
await queue.start();
await queue.work(queueName, { localConcurrency: workerConcurrency, includeMetadata: true }, async (jobs: JobWithMetadata<{ videoVersionId: string }>[]) => {
  for (const job of jobs) await transcode(job.data.videoVersionId, job.retryCount, job.retryLimit);
});
const cleanupTimer = setInterval(() => void cleanupDeletePending().catch((error) => console.error('video cleanup scan failed', { error })), 5 * 60 * 1000);

async function shutdown() {
  clearInterval(cleanupTimer);
  await queue.stop();
  await pool.end();
}
process.on('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().finally(() => process.exit(0)));