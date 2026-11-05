import express, { type Request, type Response } from 'express';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { query, withTransaction } from '../db/database.js';
import { ApiError, ok } from '../lib/http.js';
import { parse, uuid } from '../lib/validation.js';
import { assertTrainerOperational } from '../storage/course-delivery.js';
import { coverMimeTypes, MAX_COVER_UPLOAD_BYTES, normalizeCoverImage } from './cover-image.js';

const kindSchema = z.enum(['course', 'content']);
const source = {
  course: { table: 'course_runs', id: 'course_run_id', status: 'run_status',
    parent: 'courses', foreignKey: 'course_id', owner: 'owner_user_id', role: 'trainer' },
  content: { table: 'content_versions', id: 'content_version_id', status: 'version_status',
    parent: 'contents', foreignKey: 'content_id', owner: 'creator_user_id', role: 'creator' },
} as const;

// The raw parser guarantees that verify receives bytes. Do not process the
// general-purpose req.body, which can also be assigned by other body parsers.
const coverUploadBytes = new WeakMap<IncomingMessage, Buffer>();
const imageBody = express.raw({
  type: coverMimeTypes,
  limit: MAX_COVER_UPLOAD_BYTES,
  inflate: false,
  verify(req, _res, bytes) { coverUploadBytes.set(req, bytes); },
});
export const parseCoverUpload: express.RequestHandler = (req, res, next) => {
  if (!req.is(coverMimeTypes)) return next(new ApiError(415, 'COVER_TYPE_INVALID', 'Choose a JPG, PNG or WebP image.'));
  return imageBody(req, res, (error) => next(error?.status === 413
    ? new ApiError(413, 'COVER_SIZE_INVALID', 'Choose an image up to 5 MB.') : error));
};

function coverTarget(req: Request) {
  const kind = parse(kindSchema, req.params.kind);
  const id = parse(uuid, req.params.id);
  const item = source[kind];
  // Every identifier here comes from the fixed table above; values remain parameters.
  const listing = `FROM ${item.table} v JOIN ${item.parent} p USING (${item.foreignKey}) WHERE v.${item.id} = $1`;
  const state = (status: 'draft' | 'submitted' | 'published') =>
    `p.publication_status = '${status}' AND v.${item.status} = '${status}'`;
  return { kind, id, item, listing, state };
}

export async function updateListingCover(req: Request, res: Response) {
  const { kind, id, item, listing, state } = coverTarget(req);
  const actor = res.locals.actor as Actor;
  if (!actor.roles.includes(item.role)) throw new ApiError(403, 'COVER_ROLE_REQUIRED', 'Only the listing owner can edit its cover.');
  const cover = req.method === 'DELETE' ? null
    : await normalizeCoverImage(coverUploadBytes.get(req), req.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '');
  await withTransaction(async client => {
    if (kind === 'course') await assertTrainerOperational(client, actor.id);
    // Lock the same listing rows as submission, so review cannot race a cover change.
    const draft = await client.query(`SELECT 1 ${listing} AND p.${item.owner} = $2 AND ${state('draft')} FOR UPDATE OF p, v`, [id, actor.id]);
    if (!draft.rowCount) throw new ApiError(404, 'COVER_DRAFT_NOT_FOUND', 'An editable draft was not found.');
    await client.query(`UPDATE ${item.table} SET cover_image = $2 WHERE ${item.id} = $1`, [id, cover]);
  });
  return ok(res, { image: cover ? imageDataUrl(cover) : null });
}

const imageDataUrl = (cover: Buffer) => `data:image/jpeg;base64,${cover.toString('base64')}`;
export async function getPublishedListingCover(req: Request, res: Response) {
  const { id, listing, state } = coverTarget(req);
  const result = await query<{ cover_image: Buffer }>(`SELECT v.cover_image ${listing} AND ${state('published')} AND v.cover_image IS NOT NULL`, [id]);
  if (!result.rows[0]) throw new ApiError(404, 'COVER_NOT_FOUND', 'Listing cover was not found.');
  return res.set({
    'Cache-Control': 'public, max-age=300',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Content-Type': 'image/jpeg',
  }).send(result.rows[0].cover_image);
}

async function preview(req: Request, res: Response, review: boolean) {
  const { id, item, listing, state } = coverTarget(req);
  const actor = res.locals.actor as Actor;
  const result = await query<{ cover_image: Buffer | null }>(
    `SELECT v.cover_image ${listing} AND ${review ? state('submitted') : `${state('draft')} AND p.${item.owner} = $2`}`,
    review ? [id] : [id, actor.id],
  );
  if (!result.rows[0]) throw new ApiError(404, 'COVER_NOT_FOUND', 'Listing cover was not found.');
  const cover = result.rows[0].cover_image;
  return ok(res, { image: cover ? imageDataUrl(cover) : null });
}
export const previewDraftListingCover = (req: Request, res: Response) => preview(req, res, false);
export const previewReviewListingCover = (req: Request, res: Response) => preview(req, res, true);
