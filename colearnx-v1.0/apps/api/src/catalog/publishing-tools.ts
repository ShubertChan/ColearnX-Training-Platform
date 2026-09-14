import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { query, withTransaction } from '../db/database.js';
import { ApiError, ok } from '../lib/http.js';
import { parse, uuid } from '../lib/validation.js';
import { assertTrainerOperational } from '../storage/course-delivery.js';

const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().optional(),
});

const resourcesInput = z.object({
  contentVersionIds: z.array(uuid).min(1).max(50),
}).superRefine((value, context) => {
  if (new Set(value.contentVersionIds).size !== value.contentVersionIds.length) {
    context.addIssue({ code: 'custom', path: ['contentVersionIds'], message: 'Choose each resource only once.' });
  }
});

const saveResourcesInput = resourcesInput.extend({ validationId: uuid });

type OwnedCourse = { course_id: string };
type ResourceCheck = {
  content_version_id: string;
  title: string;
  creator_user_id: string;
  content_license_id: string | null;
  course_reuse_allowed: boolean;
};

async function requireOwnedDraftCourse(client: PoolClient, courseRunId: string, actor: Actor, lock = false) {
  if (!actor.roles.includes('trainer')) {
    throw new ApiError(403, 'TRAINER_ROLE_REQUIRED', 'An approved trainer role is required.');
  }
  await assertTrainerOperational(client, actor.id);
  const course = await client.query<OwnedCourse>(`SELECT c.course_id
    FROM course_runs cr JOIN courses c ON c.course_id = cr.course_id
    WHERE cr.course_run_id = $1 AND c.owner_user_id = $2
      AND c.publication_status = 'draft' AND cr.run_status = 'draft'
    ${lock ? 'FOR UPDATE OF cr, c' : ''}`,
  [courseRunId, actor.id]);
  if (!course.rowCount) {
    throw new ApiError(409, 'COURSE_RESOURCES_NOT_EDITABLE', 'Resources can only be changed on an owned draft course.');
  }
  return course.rows[0];
}

function courseReuseAllowed(terms: unknown) {
  return typeof terms === 'object' && terms !== null
    && (terms as Record<string, unknown>).courseReuseAllowed === true;
}

async function checkResources(client: PoolClient, courseRunId: string, actor: Actor, contentVersionIds: string[], lockCourse = false) {
  await requireOwnedDraftCourse(client, courseRunId, actor, lockCourse);
  const resources = await client.query<ResourceCheck>(`SELECT cv.content_version_id, c.title, c.creator_user_id,
      license.content_license_id, COALESCE((license.license_terms_json->>'courseReuseAllowed')::boolean, false) AS course_reuse_allowed
    FROM content_versions cv
    JOIN contents c ON c.content_id = cv.content_id
    LEFT JOIN LATERAL (
      SELECT cl.content_license_id, cl.license_terms_json
      FROM content_licenses cl
      JOIN order_items oi ON oi.order_item_id = cl.order_item_id
      JOIN orders o ON o.order_id = oi.order_id
      WHERE cl.content_version_id = cv.content_version_id
        AND cl.buyer_user_id = $2
        AND (cl.valid_until IS NULL OR cl.valid_until > now())
        AND oi.fulfilment_status NOT IN ('refunded', 'cancelled')
        AND o.order_status NOT IN ('refunded', 'cancelled')
      ORDER BY cl.content_license_id
      LIMIT 1
    ) license ON true
    WHERE cv.content_version_id = ANY($1::uuid[])
      AND c.publication_status = 'published' AND cv.version_status = 'published'`,
  [contentVersionIds, actor.id]);

  const byId = new Map(resources.rows.map((row) => [row.content_version_id, row]));
  const allowed: Array<{ contentVersionId: string; contentLicenseId: string | null; title: string }> = [];
  const denied: Array<{ contentVersionId: string; title: string; reason: string }> = [];
  for (const contentVersionId of contentVersionIds) {
    const resource = byId.get(contentVersionId);
    if (!resource) {
      denied.push({ contentVersionId, title: 'Unknown resource', reason: 'The resource is not currently published.' });
    } else if (resource.creator_user_id === actor.id) {
      allowed.push({ contentVersionId, contentLicenseId: null, title: resource.title });
    } else if (resource.content_license_id && resource.course_reuse_allowed) {
      allowed.push({ contentVersionId, contentLicenseId: resource.content_license_id, title: resource.title });
    } else {
      denied.push({ contentVersionId, title: resource.title, reason: 'This licence does not permit use inside another course.' });
    }
  }
  return { allowed, denied };
}

export async function listCourseVersions(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const courseRunId = parse(uuid, req.params.id);
  const input = parse(historyQuery, req.query);
  const cursor = input.cursor ? parse(uuid, input.cursor) : null;
  const owner = await query<OwnedCourse>(`SELECT c.course_id FROM course_runs cr
    JOIN courses c ON c.course_id = cr.course_id
    WHERE cr.course_run_id = $1 AND c.owner_user_id = $2`, [courseRunId, actor.id]);
  if (!owner.rowCount) throw new ApiError(404, 'LISTING_NOT_FOUND', 'The listing was not found.');
  const result = await query<{ course_run_id: string; run_code: string; run_status: string; updated_at: Date }>(`SELECT cr.course_run_id, cr.run_code, cr.run_status, c.updated_at
    FROM course_runs cr JOIN courses c ON c.course_id = cr.course_id
    WHERE cr.course_id = $1 AND ($2::uuid IS NULL OR cr.course_run_id < $2::uuid)
    ORDER BY cr.course_run_id DESC LIMIT $3`, [owner.rows[0].course_id, cursor, input.limit + 1]);
  const rows = result.rows.slice(0, input.limit);
  const hasNext = result.rows.length > input.limit;
  return ok(res, rows.map((row) => ({ id: row.course_run_id, version: row.run_code, status: row.run_status,
    createdAt: row.updated_at, changeSummary: 'Course offering record' })), 200,
  { nextCursor: hasNext ? rows.at(-1)?.course_run_id : null, hasNext });
}

export async function listContentVersions(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const contentId = parse(uuid, req.params.id);
  const input = parse(historyQuery, req.query);
  const cursor = input.cursor ? Number(input.cursor) : undefined;
  if (cursor !== undefined && (!Number.isInteger(cursor) || cursor <= 0)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The request is invalid.');
  }
  const result = await query<{ content_version_id: string; version_no: number; version_status: string; created_at: Date }>(`SELECT cv.content_version_id, cv.version_no, cv.version_status,
      COALESCE(cv.published_at, c.updated_at, c.created_at) AS created_at
    FROM contents c JOIN content_versions cv ON cv.content_id = c.content_id
    WHERE c.content_id = $1 AND c.creator_user_id = $2
      AND ($3::int IS NULL OR cv.version_no < $3::int)
    ORDER BY cv.version_no DESC LIMIT $4`, [contentId, actor.id, cursor ?? null, input.limit + 1]);
  if (!result.rowCount && !cursor) throw new ApiError(404, 'LISTING_NOT_FOUND', 'The listing was not found.');
  const rows = result.rows.slice(0, input.limit);
  const hasNext = result.rows.length > input.limit;
  return ok(res, rows.map((row) => ({ id: row.content_version_id, version: row.version_no, status: row.version_status,
    createdAt: row.created_at, changeSummary: `Content version ${row.version_no}` })), 200,
  { nextCursor: hasNext ? String(rows.at(-1)?.version_no) : null, hasNext });
}

export async function validateCourseResources(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const courseRunId = parse(uuid, req.params.id);
  const input = parse(resourcesInput, req.body);
  const result = await withTransaction((client) => checkResources(client, courseRunId, actor, input.contentVersionIds));
  const allowed = result.denied.length === 0;
  return ok(res, { allowed, validationId: allowed ? randomUUID() : null, resources: result.allowed, denied: result.denied,
    explanation: allowed ? 'Every selected resource has a current course-reuse licence.' : result.denied.map((item) => `${item.title}: ${item.reason}`).join(' ') });
}

export async function saveCourseResources(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const courseRunId = parse(uuid, req.params.id);
  const input = parse(saveResourcesInput, req.body);
  const result = await withTransaction(async (client) => {
    const resources = await checkResources(client, courseRunId, actor, input.contentVersionIds, true);
    if (resources.denied.length) {
      throw new ApiError(409, 'RESOURCE_LICENSE_NOT_APPROVED', resources.denied.map((item) => `${item.title}: ${item.reason}`).join(' '));
    }
    await client.query('DELETE FROM course_run_content_resources WHERE course_run_id = $1', [courseRunId]);
    for (const resource of resources.allowed) {
      await client.query(`INSERT INTO course_run_content_resources
        (course_run_id, content_version_id, content_license_id, added_by_user_id)
        VALUES ($1, $2, $3, $4)`, [courseRunId, resource.contentVersionId, resource.contentLicenseId, actor.id]);
    }
    await client.query(`INSERT INTO admin_action_logs
      (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, 'course.resources.update', 'course_runs', $2,
        jsonb_build_object('resourceCount', $3::int, 'validationId', $4::uuid), $5)`,
    [actor.id, courseRunId, resources.allowed.length, input.validationId, res.locals.requestId]);
    return { savedCount: resources.allowed.length };
  });
  return ok(res, { id: courseRunId, validationId: input.validationId, ...result });
}
