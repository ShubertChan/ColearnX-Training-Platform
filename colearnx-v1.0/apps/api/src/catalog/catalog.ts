import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { query, withTransaction } from '../db/database.js';
import { ApiError, ok } from '../lib/http.js';
import { parse, uuid } from '../lib/validation.js';

const listQuery = z.object({ q: z.string().trim().max(120).optional(), category: z.string().trim().max(80).optional(), cursor: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(20) });
const courseInput = z.object({ title: z.string().trim().min(1).max(200), description: z.string().trim().max(5000).default(''), categoryId: uuid.optional(), pricePoints: z.coerce.number().int().nonnegative(), capacity: z.coerce.number().int().positive().nullable().optional(), startsAt: z.string().datetime().nullable().optional(), endsAt: z.string().datetime().nullable().optional(), timezone: z.string().trim().max(80).optional(), deliveryModes: z.array(z.enum(['cloud', 'local', 'live', 'record'])).min(1).max(4) });
const contentInput = z.object({ title: z.string().trim().min(1).max(200), categoryId: uuid.optional(), contentType: z.string().trim().min(1).max(80).default('digital'), pricePoints: z.coerce.number().int().nonnegative(), storageUrl: z.string().url().max(2000).optional() });
const moderationDecisionInput = z.object({ decision: z.enum(['published', 'rejected']), reason: z.string().trim().min(3).max(2_000) });
const moderationListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

function courseResponse(row: Record<string, unknown>) {
  return { id: row.course_run_id, courseId: row.course_id, title: row.title, description: row.description, pricePoints: Number(row.price_points), capacity: row.capacity, status: row.run_status, startsAt: row.starts_at, endsAt: row.ends_at, owner: { id: row.owner_user_id, displayName: row.owner_name }, category: row.category_id ? { id: row.category_id, name: row.category_name } : null, deliveryModes: row.delivery_modes ?? [] };
}

export async function listCourses(req: Request, res: Response) {
  const input = parse(listQuery, req.query);
  const result = await query(`SELECT cr.course_run_id, c.course_id, c.title, c.description, cr.price_points, cr.capacity, cr.run_status, cr.starts_at, cr.ends_at, c.owner_user_id, u.full_name AS owner_name, c.category_id, cat.category_name,
    COALESCE(jsonb_agg(cdo.delivery_type) FILTER (WHERE cdo.delivery_type IS NOT NULL), '[]'::jsonb) AS delivery_modes
    FROM course_runs cr JOIN courses c ON c.course_id = cr.course_id JOIN users u ON u.user_id = c.owner_user_id
    LEFT JOIN categories cat ON cat.category_id = c.category_id LEFT JOIN course_delivery_options cdo ON cdo.course_run_id = cr.course_run_id AND cdo.option_status = 'active'
    WHERE c.publication_status = 'published' AND cr.run_status = 'published'
      AND ($1::text IS NULL OR c.search_vector @@ websearch_to_tsquery('simple', $1))
      AND ($2::text IS NULL OR cat.category_name = $2)
      AND ($3::timestamptz IS NULL OR cr.starts_at < $3::timestamptz)
    GROUP BY cr.course_run_id, c.course_id, u.user_id, cat.category_id
    ORDER BY cr.starts_at DESC NULLS LAST, cr.course_run_id DESC LIMIT $4`, [input.q || null, input.category || null, input.cursor ?? null, input.limit]);
  const items = result.rows.map(courseResponse);
  return ok(res, items, 200, { nextCursor: items.length === input.limit ? items.at(-1)?.startsAt : null });
}

export async function getCourse(req: Request, res: Response) {
  const id = parse(uuid, req.params.id);
  const result = await query(`SELECT cr.course_run_id, c.course_id, c.title, c.description, cr.price_points, cr.capacity, cr.run_status, cr.starts_at, cr.ends_at, c.owner_user_id, u.full_name AS owner_name, c.category_id, cat.category_name,
    COALESCE(jsonb_agg(cdo.delivery_type) FILTER (WHERE cdo.delivery_type IS NOT NULL), '[]'::jsonb) AS delivery_modes
    FROM course_runs cr JOIN courses c ON c.course_id = cr.course_id JOIN users u ON u.user_id = c.owner_user_id
    LEFT JOIN categories cat ON cat.category_id = c.category_id LEFT JOIN course_delivery_options cdo ON cdo.course_run_id = cr.course_run_id AND cdo.option_status = 'active'
    WHERE cr.course_run_id = $1 AND c.publication_status = 'published' AND cr.run_status = 'published'
    GROUP BY cr.course_run_id, c.course_id, u.user_id, cat.category_id`, [id]);
  if (!result.rowCount) throw new ApiError(404, 'COURSE_NOT_FOUND', 'Course offering was not found.');
  return ok(res, courseResponse(result.rows[0]));
}

export async function listContent(req: Request, res: Response) {
  const input = parse(listQuery, req.query);
  const result = await query(`SELECT c.content_id, cv.content_version_id, c.title, c.content_type, c.price_points, c.publication_status, cv.published_at, c.creator_user_id, u.full_name AS owner_name, c.category_id, cat.category_name
    FROM contents c JOIN content_versions cv ON cv.content_id = c.content_id AND cv.version_status = 'published' JOIN users u ON u.user_id = c.creator_user_id
    LEFT JOIN categories cat ON cat.category_id = c.category_id
    WHERE c.publication_status = 'published' AND ($1::text IS NULL OR c.search_vector @@ websearch_to_tsquery('simple', $1))
      AND ($2::text IS NULL OR cat.category_name = $2) AND ($3::timestamptz IS NULL OR cv.published_at < $3::timestamptz)
    ORDER BY cv.published_at DESC, cv.content_version_id DESC LIMIT $4`, [input.q || null, input.category || null, input.cursor ?? null, input.limit]);
  const items = result.rows.map((row) => ({ id: row.content_version_id, contentId: row.content_id, title: row.title, contentType: row.content_type, pricePoints: Number(row.price_points), status: row.publication_status, publishedAt: row.published_at, owner: { id: row.creator_user_id, displayName: row.owner_name }, category: row.category_id ? { id: row.category_id, name: row.category_name } : null }));
  return ok(res, items, 200, { nextCursor: items.length === input.limit ? items.at(-1)?.publishedAt : null });
}

export async function getContent(req: Request, res: Response) {
  const id = parse(uuid, req.params.id);
  const result = await query(`SELECT c.content_id, cv.content_version_id, c.title, c.content_type, c.price_points, c.publication_status, cv.published_at, c.creator_user_id, u.full_name AS owner_name, c.category_id, cat.category_name
    FROM contents c JOIN content_versions cv ON cv.content_id = c.content_id AND cv.version_status = 'published' JOIN users u ON u.user_id = c.creator_user_id
    LEFT JOIN categories cat ON cat.category_id = c.category_id WHERE cv.content_version_id = $1 AND c.publication_status = 'published'`, [id]);
  if (!result.rowCount) throw new ApiError(404, 'CONTENT_NOT_FOUND', 'Content version was not found.');
  const row = result.rows[0];
  return ok(res, { id: row.content_version_id, contentId: row.content_id, title: row.title, contentType: row.content_type, pricePoints: Number(row.price_points), status: row.publication_status, publishedAt: row.published_at, owner: { id: row.creator_user_id, displayName: row.owner_name }, category: row.category_id ? { id: row.category_id, name: row.category_name } : null });
}

export async function createCourse(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(courseInput, req.body);
  if (!actor.roles.includes('trainer')) throw new ApiError(403, 'TRAINER_ROLE_REQUIRED', 'An approved trainer role is required.');
  const course = await withTransaction(async (client) => {
    const certified = await client.query(`SELECT 1 FROM trainer_certifications WHERE trainer_user_id = $1 AND certification_status = 'approved'`, [actor.id]);
    if (!certified.rowCount) throw new ApiError(403, 'TRAINER_CERTIFICATION_REQUIRED', 'An approved trainer certification is required.');
    const created = await client.query<{ course_id: string }>(`INSERT INTO courses (owner_user_id, category_id, title, description) VALUES ($1, $2, $3, $4) RETURNING course_id`, [actor.id, input.categoryId ?? null, input.title, input.description]);
    const run = await client.query<{ course_run_id: string }>(`INSERT INTO course_runs (course_id, run_code, price_points, capacity, starts_at, ends_at, timezone, primary_delivery_type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING course_run_id`, [created.rows[0].course_id, `run-${randomUUID()}`, input.pricePoints, input.capacity ?? null, input.startsAt ?? null, input.endsAt ?? null, input.timezone ?? null, input.deliveryModes[0]]);
    for (const [index, mode] of input.deliveryModes.entries()) await client.query(`INSERT INTO course_delivery_options (course_run_id, delivery_type, access_mode, is_primary, option_status) VALUES ($1, $2, $3, $4, 'draft')`, [run.rows[0].course_run_id, mode, mode === 'live' ? 'attendance' : 'on_demand', index === 0]);
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id) VALUES ($1, 'course.create', 'courses', $2, jsonb_build_object('courseRunId', $3::uuid), $4)`, [actor.id, created.rows[0].course_id, run.rows[0].course_run_id, res.locals.requestId]);
    return { id: run.rows[0].course_run_id, courseId: created.rows[0].course_id, status: 'draft' };
  });
  return ok(res, course, 201);
}

export async function createContent(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(contentInput, req.body);
  if (!actor.roles.includes('creator')) throw new ApiError(403, 'CREATOR_ROLE_REQUIRED', 'An approved creator role is required.');
  const result = await withTransaction(async (client) => {
    const content = await client.query<{ content_id: string }>(`INSERT INTO contents (creator_user_id, category_id, content_type, title, price_points) VALUES ($1, $2, $3, $4, $5) RETURNING content_id`, [actor.id, input.categoryId ?? null, input.contentType, input.title, input.pricePoints]);
    const version = await client.query<{ content_version_id: string }>(`INSERT INTO content_versions (content_id, version_no, storage_url) VALUES ($1, 1, $2) RETURNING content_version_id`, [content.rows[0].content_id, input.storageUrl ?? null]);
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, request_id) VALUES ($1, 'content.create', 'contents', $2, $3)`, [actor.id, content.rows[0].content_id, res.locals.requestId]);
    return { id: content.rows[0].content_id, contentVersionId: version.rows[0].content_version_id, status: 'draft' };
  });
  return ok(res, result, 201);
}

export async function submitCourse(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const id = parse(uuid, req.params.id);
  const result = await withTransaction(async (client) => {
    const course = await client.query<{ course_id: string }>(`UPDATE courses SET publication_status = 'submitted', updated_at = now() WHERE course_id = (SELECT course_id FROM course_runs WHERE course_run_id = $1) AND owner_user_id = $2 AND publication_status = 'draft' RETURNING course_id`, [id, actor.id]);
    if (!course.rowCount) throw new ApiError(409, 'COURSE_NOT_SUBMITTABLE', 'Only an owned draft course offering may be submitted.');
    await client.query(`UPDATE course_runs SET run_status = 'submitted' WHERE course_run_id = $1 AND run_status = 'draft'`, [id]);
    await client.query(`UPDATE course_delivery_options SET option_status = 'draft' WHERE course_run_id = $1`, [id]);
    return { id, status: 'submitted' };
  });
  return ok(res, result);
}

export async function submitContent(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const contentId = parse(uuid, req.params.id);
  const result = await withTransaction(async (client) => {
    const content = await client.query<{ content_version_id: string }>(`SELECT cv.content_version_id
      FROM contents c JOIN content_versions cv ON cv.content_id = c.content_id
      WHERE c.content_id = $1 AND c.creator_user_id = $2 AND c.publication_status = 'draft'
        AND cv.version_status = 'draft' AND cv.version_no = 1
      FOR UPDATE OF c, cv`, [contentId, actor.id]);
    if (!content.rowCount) throw new ApiError(409, 'CONTENT_NOT_SUBMITTABLE', 'Only an owned draft content item may be submitted.');
    await client.query(`UPDATE contents SET publication_status = 'submitted', updated_at = now() WHERE content_id = $1`, [contentId]);
    await client.query(`UPDATE content_versions SET version_status = 'submitted' WHERE content_version_id = $1`, [content.rows[0].content_version_id]);
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, request_id)
      VALUES ($1, 'content.submit', 'contents', $2, $3)`, [actor.id, contentId, res.locals.requestId]);
    return { id: contentId, contentVersionId: content.rows[0].content_version_id, status: 'submitted' };
  });
  return ok(res, result);
}

export async function listMyListings(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const [courseResult, contentResult] = await Promise.all([
    query(`SELECT cr.course_run_id, c.course_id, c.title, c.description, cr.price_points, cr.capacity,
      cr.starts_at, cr.ends_at, cr.run_status, c.publication_status, c.updated_at,
      COALESCE(jsonb_agg(cdo.delivery_type) FILTER (WHERE cdo.delivery_type IS NOT NULL), '[]'::jsonb) AS delivery_modes
      FROM courses c JOIN course_runs cr ON cr.course_id = c.course_id
      LEFT JOIN course_delivery_options cdo ON cdo.course_run_id = cr.course_run_id
      WHERE c.owner_user_id = $1
      GROUP BY cr.course_run_id, c.course_id
      ORDER BY c.updated_at DESC, cr.course_run_id DESC`, [actor.id]),
    query(`SELECT c.content_id, cv.content_version_id, c.title, c.content_type, c.price_points,
      c.publication_status, cv.version_status, cv.storage_url, c.updated_at
      FROM contents c JOIN content_versions cv ON cv.content_id = c.content_id
      WHERE c.creator_user_id = $1
      ORDER BY c.updated_at DESC, cv.version_no DESC`, [actor.id]),
  ]);
  const courses = courseResult.rows.map((row) => ({
    kind: 'course', id: row.course_run_id, courseId: row.course_id, title: row.title,
    description: row.description, pricePoints: Number(row.price_points), capacity: row.capacity,
    startsAt: row.starts_at, endsAt: row.ends_at, status: row.run_status,
    publicationStatus: row.publication_status, deliveryModes: row.delivery_modes ?? [], updatedAt: row.updated_at,
  }));
  const contents = contentResult.rows.map((row) => ({
    kind: 'content', id: row.content_id, contentVersionId: row.content_version_id, title: row.title,
    contentType: row.content_type, pricePoints: Number(row.price_points), status: row.publication_status,
    versionStatus: row.version_status, storageUrlPresent: Boolean(row.storage_url), updatedAt: row.updated_at,
  }));
  return ok(res, [...courses, ...contents].sort((left, right) =>
    new Date(String(right.updatedAt)).getTime() - new Date(String(left.updatedAt)).getTime(),
  ));
}

export async function listCourseSubmissions(req: Request, res: Response) {
  const input = parse(moderationListQuery, req.query);
  const result = await query(`SELECT cr.course_run_id, c.course_id, c.title, c.description, c.owner_user_id,
    u.full_name AS owner_name, cr.price_points, cr.starts_at, cr.ends_at, cr.run_status,
    COALESCE(jsonb_agg(cdo.delivery_type) FILTER (WHERE cdo.delivery_type IS NOT NULL), '[]'::jsonb) AS delivery_modes
    FROM course_runs cr JOIN courses c ON c.course_id = cr.course_id JOIN users u ON u.user_id = c.owner_user_id
    LEFT JOIN course_delivery_options cdo ON cdo.course_run_id = cr.course_run_id
    WHERE c.publication_status = 'submitted' AND cr.run_status = 'submitted'
    GROUP BY cr.course_run_id, c.course_id, u.user_id
    ORDER BY c.updated_at ASC, cr.course_run_id ASC LIMIT $1`, [input.limit]);
  return ok(res, result.rows.map((row) => ({ ...courseResponse(row), moderationStatus: 'submitted' })));
}

export async function decideCourseSubmission(req: Request, res: Response) {
  const admin = res.locals.actor as Actor;
  const courseRunId = parse(uuid, req.params.id);
  const input = parse(moderationDecisionInput, req.body);
  const result = await withTransaction(async (client) => {
    const course = await client.query<{ course_id: string }>(`SELECT c.course_id FROM course_runs cr
      JOIN courses c ON c.course_id = cr.course_id
      WHERE cr.course_run_id = $1 AND cr.run_status = 'submitted' AND c.publication_status = 'submitted'
      FOR UPDATE OF cr, c`, [courseRunId]);
    if (!course.rowCount) throw new ApiError(409, 'COURSE_NOT_REVIEWABLE', 'Only a submitted course offering may be reviewed.');
    if (input.decision === 'published') {
      const options = await client.query(`SELECT 1 FROM course_delivery_options WHERE course_run_id = $1 AND option_status = 'draft'`, [courseRunId]);
      if (!options.rowCount) throw new ApiError(409, 'COURSE_DELIVERY_UNAVAILABLE', 'A submitted course must have at least one delivery option.');
      await client.query(`UPDATE courses SET publication_status = 'published', updated_at = now() WHERE course_id = $1`, [course.rows[0].course_id]);
      await client.query(`UPDATE course_runs SET run_status = 'published' WHERE course_run_id = $1`, [courseRunId]);
      await client.query(`UPDATE course_delivery_options SET option_status = 'active' WHERE course_run_id = $1 AND option_status = 'draft'`, [courseRunId]);
    } else {
      await client.query(`UPDATE courses SET publication_status = 'rejected', updated_at = now() WHERE course_id = $1`, [course.rows[0].course_id]);
      await client.query(`UPDATE course_runs SET run_status = 'archived' WHERE course_run_id = $1`, [courseRunId]);
      await client.query(`UPDATE course_delivery_options SET option_status = 'disabled' WHERE course_run_id = $1`, [courseRunId]);
    }
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, 'course.moderation', 'course_runs', $2,
      jsonb_build_object('decision', $3::text, 'reason', $4::text, 'outcome', 'success'), $5)`,
      [admin.id, courseRunId, input.decision, input.reason, res.locals.requestId]);
    await client.query(`INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
      VALUES ('course_run', $1, $2, jsonb_build_object('courseRunId', $1::uuid, 'reason', $3::text))`,
      [courseRunId, input.decision === 'published' ? 'course.published' : 'course.rejected', input.reason]);
    return { id: courseRunId, status: input.decision };
  });
  return ok(res, result);
}

export async function listContentSubmissions(req: Request, res: Response) {
  const input = parse(moderationListQuery, req.query);
  const result = await query(`SELECT c.content_id, cv.content_version_id, c.title, c.content_type, c.price_points,
    c.creator_user_id, u.full_name AS owner_name, cv.storage_url, cv.version_status
    FROM contents c JOIN content_versions cv ON cv.content_id = c.content_id JOIN users u ON u.user_id = c.creator_user_id
    WHERE c.publication_status = 'submitted' AND cv.version_status = 'submitted'
    ORDER BY c.updated_at ASC, cv.content_version_id ASC LIMIT $1`, [input.limit]);
  return ok(res, result.rows.map((row) => ({
    id: row.content_version_id, contentId: row.content_id, title: row.title, contentType: row.content_type,
    pricePoints: Number(row.price_points), owner: { id: row.creator_user_id, displayName: row.owner_name },
    storageUrlPresent: Boolean(row.storage_url), moderationStatus: row.version_status,
  })));
}

export async function decideContentSubmission(req: Request, res: Response) {
  const admin = res.locals.actor as Actor;
  const contentVersionId = parse(uuid, req.params.id);
  const input = parse(moderationDecisionInput, req.body);
  const result = await withTransaction(async (client) => {
    const content = await client.query<{ content_id: string }>(`SELECT c.content_id FROM content_versions cv
      JOIN contents c ON c.content_id = cv.content_id
      WHERE cv.content_version_id = $1 AND cv.version_status = 'submitted' AND c.publication_status = 'submitted'
      FOR UPDATE OF cv, c`, [contentVersionId]);
    if (!content.rowCount) throw new ApiError(409, 'CONTENT_NOT_REVIEWABLE', 'Only submitted content may be reviewed.');
    if (input.decision === 'published') {
      await client.query(`UPDATE contents SET publication_status = 'published', updated_at = now() WHERE content_id = $1`, [content.rows[0].content_id]);
      await client.query(`UPDATE content_versions SET version_status = 'published', published_at = now() WHERE content_version_id = $1`, [contentVersionId]);
    } else {
      await client.query(`UPDATE contents SET publication_status = 'rejected', updated_at = now() WHERE content_id = $1`, [content.rows[0].content_id]);
      await client.query(`UPDATE content_versions SET version_status = 'rejected' WHERE content_version_id = $1`, [contentVersionId]);
    }
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, 'content.moderation', 'content_versions', $2,
      jsonb_build_object('decision', $3::text, 'reason', $4::text, 'outcome', 'success'), $5)`,
      [admin.id, contentVersionId, input.decision, input.reason, res.locals.requestId]);
    await client.query(`INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
      VALUES ('content_version', $1, $2, jsonb_build_object('contentVersionId', $1::uuid, 'reason', $3::text))`,
      [contentVersionId, input.decision === 'published' ? 'content.published' : 'content.rejected', input.reason]);
    return { id: contentVersionId, status: input.decision };
  });
  return ok(res, result);
}
