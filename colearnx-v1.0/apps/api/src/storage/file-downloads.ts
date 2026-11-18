import { createHash, randomBytes } from 'node:crypto';
import { finished } from 'node:stream/promises';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { env } from '../config/env.js';
import { query } from '../db/database.js';
import { ApiError } from '../lib/http.js';
import { openDownloadStream, safeContentDisposition } from './r2.js';

type Span = { start: number; end: number }; // half-open byte offsets
type PurchasedFile = {
  bucket: string; key: string; filename: string; media_type: string; size_bytes: string; etag: string | null;
};
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const invalidLink = () => new ApiError(404, 'DOWNLOAD_UNAVAILABLE', 'This download link is unavailable. Request a new link in My Learning.');

export async function issueFileDownload(client: PoolClient, orderItemId: string, kind: 'content' | 'course', assetId: string) {
  if (env.OBJECT_STORAGE_PROVIDER !== 'r2') throw new ApiError(503, 'OBJECT_STORAGE_UNAVAILABLE', 'Object storage is not configured.');
  const token = randomBytes(32).toString('base64url');
  // Keep expired transfers briefly so a response already streaming can finish.
  await client.query(`DELETE FROM file_download_links WHERE token_hash IN (
    SELECT token_hash FROM file_download_links WHERE expires_at < now() - interval '1 day'
    ORDER BY expires_at LIMIT 32 FOR UPDATE SKIP LOCKED)`);
  await client.query(`INSERT INTO file_download_links(token_hash, order_item_id, content_asset_id, course_asset_id, expires_at)
    VALUES ($1, $2, $3, $4, now() + $5 * interval '1 second')`,
  [hashToken(token), orderItemId, kind === 'content' ? assetId : null, kind === 'course' ? assetId : null, env.R2_SIGNED_DOWNLOAD_TTL_SECONDS]);
  const url = new URL('/api/v1/file-download', env.API_ORIGIN);
  url.searchParams.set('ticket', token);
  return url.href;
}

async function lookupFile(hash: string) {
  const result = await query<PurchasedFile>(`SELECT COALESCE(sa.bucket_name, ca.bucket_name) AS bucket,
    COALESCE(sa.object_key, ca.object_key) AS key, COALESCE(sa.original_filename, ca.original_filename) AS filename,
    COALESCE(sa.verified_content_type, sa.declared_content_type, ca.verified_content_type, ca.declared_content_type) AS media_type,
    COALESCE(sa.verified_byte_size, sa.declared_byte_size, ca.verified_byte_size, ca.declared_byte_size) AS size_bytes,
    COALESCE(sa.etag, ca.etag) AS etag
    FROM file_download_links l JOIN order_items oi USING (order_item_id) JOIN orders o USING (order_id)
    LEFT JOIN storage_assets sa ON sa.storage_asset_id = l.content_asset_id AND sa.content_version_id = oi.content_version_id AND sa.asset_status = 'ready'
    LEFT JOIN course_delivery_assets ca ON ca.course_delivery_asset_id = l.course_asset_id AND ca.course_run_id = oi.course_run_id
      AND ca.asset_purpose = 'cloud_download' AND ca.asset_status = 'ready'
    WHERE l.token_hash = $1 AND l.expires_at > clock_timestamp() AND o.paid_at IS NOT NULL
      AND oi.fulfilment_status IN ('paid','reserved','fulfilled')
      AND ((sa.storage_asset_id IS NOT NULL AND EXISTS (SELECT 1 FROM content_access_grants g
        WHERE g.order_item_id = oi.order_item_id AND g.user_id = o.buyer_user_id AND (g.expires_at IS NULL OR g.expires_at > now())))
        OR (ca.course_delivery_asset_id IS NOT NULL AND EXISTS (SELECT 1 FROM course_enrolments ce
        WHERE ce.order_item_id = oi.order_item_id AND ce.learner_user_id = o.buyer_user_id)))`, [hash]);
  if (!result.rowCount) throw invalidLink();
  return result.rows[0];
}

function byteRange(header: string, size: number): Span {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (match && (match[1] || match[2])) {
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(size, Number(match[2]) + 1) : size;
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < end) return { start, end };
  }
  throw new ApiError(416, 'DOWNLOAD_RANGE_INVALID', 'The requested byte range is unavailable.');
}

async function newTransfer(hash: string) {
  const fresh = await query<{ transfer_id: string }>(
    'INSERT INTO file_download_transfers(token_hash) VALUES ($1) RETURNING transfer_id', [hash]);
  return fresh.rows[0].transfer_id;
}

async function redirectToNewTransfer(res: Response, token: string, hash: string) {
  const location = new URL('/api/v1/file-download', env.API_ORIGIN);
  location.searchParams.set('ticket', token);
  location.searchParams.set('transfer', await newTransfer(hash));
  return res.status(307).set('Location', location.href).end();
}

const transferIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function hasTransfer(hash: string, id: string) {
  if (!transferIdPattern.test(id)) return false;
  const found = await query('SELECT 1 FROM file_download_transfers WHERE token_hash=$1 AND transfer_id=$2', [hash, id]);
  return Boolean(found.rowCount);
}

async function saveDeliveredBytes(id: string, span: Span, size: number) {
  if (span.end <= span.start) return;
  // A concurrent retry can win the transition once. Range union removes overlap.
  await query(`WITH coverage AS (
    UPDATE file_download_transfers SET
      delivered = delivered + int8multirange(int8range($2, $3, '[)')),
      completed = (delivered + int8multirange(int8range($2, $3, '[)'))) @> int8range(0, $4, '[)')
    WHERE transfer_id = $1 AND NOT completed RETURNING token_hash, completed
  ) UPDATE order_items oi SET completed_file_downloads = oi.completed_file_downloads + 1
    FROM coverage JOIN file_download_links l USING (token_hash)
    WHERE coverage.completed AND oi.order_item_id = l.order_item_id`,
  [id, span.start, span.end, size]);
}

export async function serveFileDownload(req: Request, res: Response) {
  const token = req.query.ticket;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalidLink();
  const hash = hashToken(token);
  const file = await lookupFile(hash);
  const size = Number(file.size_bytes);
  res.set({ 'Cache-Control': 'private, no-store, no-transform', 'Accept-Ranges': 'bytes', 'Referrer-Policy': 'no-referrer' });
  const canonical = req.query.transfer;
  let id: string | undefined;
  if (canonical !== undefined) {
    if (typeof canonical !== 'string' || !await hasTransfer(hash, canonical)) throw invalidLink();
    id = canonical;
  }
  const rangeHeader = req.method === 'HEAD' ? undefined : req.get('range');
  const validator = rangeHeader && req.get('if-range');
  let span: Span | undefined;
  if (validator) {
    const candidate = /^"cx-([^"]+)"$/.exec(validator)?.[1];
    if (candidate && (candidate === id || await hasTransfer(hash, candidate))) id = candidate;
    else id = await newTransfer(hash); // An unmatched If-Range requires a fresh full response.
  }
  if (rangeHeader && (!validator || validator === `"cx-${id}"`)) {
    try { span = byteRange(rangeHeader, size); } catch (error) {
      res.set('Content-Range', `bytes */${size}`);
      throw error;
    }
  }
  if (!id) {
    // One issued link may be opened twice. Separate the two transfers before
    // streaming so independent partial reads can never be pooled across opens.
    return redirectToNewTransfer(res, token, hash);
  }
  if (req.method === 'HEAD') {
    return res.set({ ETag: `"cx-${id}"`, 'Content-Type': file.media_type, 'Content-Length': String(size),
      'Content-Disposition': safeContentDisposition(file.filename, 'attachment') }).end();
  }
  if (!span) {
    const first = await query(`UPDATE file_download_transfers SET full_started=true WHERE transfer_id=$1
      AND NOT full_started AND NOT completed AND delivered='{}' RETURNING transfer_id`, [id]);
    if (!first.rowCount) return redirectToNewTransfer(res, token, hash);
  }
  const delivery = span ?? { start: 0, end: size };
  const abort = new AbortController();
  const onClose = () => abort.abort();
  res.once('close', onClose);
  let written = 0;
  let complete = false;
  try {
    if (res.destroyed) return;
    const { body, sourceEtag } = await openDownloadStream({ bucketName: file.bucket, objectKey: file.key }, file.etag, size, span, abort.signal);
    if (!file.etag) {
      // Older ready assets have no verified ETag in PostgreSQL. Pin the first
      // storage response so a resume cannot join two revisions of equal size.
      const pinned = await query(`UPDATE file_download_transfers SET source_etag=$2
        WHERE transfer_id=$1 AND (source_etag IS NULL OR source_etag=$2) RETURNING transfer_id`, [id, sourceEtag]);
      if (!pinned.rowCount) throw new ApiError(409, 'DOWNLOAD_FILE_CHANGED', 'The file has changed. Start a new download.');
    }
    res.status(span ? 206 : 200).set({
      'Content-Type': file.media_type, 'Content-Disposition': safeContentDisposition(file.filename, 'attachment'),
      'Content-Length': String(delivery.end - delivery.start), ETag: `"cx-${id}"`,
    });
    if (span) res.set('Content-Range', `bytes ${span.start}-${span.end - 1}/${size}`);
    for await (const chunk of body) {
      if (abort.signal.aborted || written + chunk.length > delivery.end - delivery.start) throw new Error('Incomplete file delivery');
      // The write callback applies backpressure and bounds the acknowledged prefix on disconnect.
      await new Promise<void>((resolve, reject) => res.write(chunk, error => error ? reject(error) : resolve()));
      written += chunk.length;
    }
    if (written !== delivery.end - delivery.start) throw new Error('Incomplete file delivery');
    const flushed = finished(res, { cleanup: true });
    res.end();
    await flushed;
    complete = true;
  } catch (error) {
    if (!res.headersSent && !res.destroyed) {
      for (const header of ['Content-Type','Content-Disposition','Content-Length','Content-Range','ETag']) res.removeHeader(header);
      throw error;
    }
    res.destroy();
  } finally {
    res.off('close', onClose);
    abort.abort();
    // A disconnected response cannot complete a transfer. Its flushed prefix
    // can still be combined with a later, successfully finished resume.
    const confirmed = complete ? written : Math.min(written, delivery.end - delivery.start - 1);
    const confirmedSpan = { start: delivery.start, end: delivery.start + confirmed };
    const persist = () => saveDeliveredBytes(id, confirmedSpan, size);
    await persist().catch(persist)
      .catch(error => res.locals.log?.error({ err: error, transferId: id }, 'Failed to record file delivery'));
  }
}
