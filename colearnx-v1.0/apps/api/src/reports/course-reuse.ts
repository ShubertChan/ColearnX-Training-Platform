import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { query } from '../db/database.js';
import { ok } from '../lib/http.js';
import { safeMetric } from '../lib/reporting-query.js';
import { parse, uuid } from '../lib/validation.js';

const pageInput = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
}).strict();

type ResourceRow = { id: string; title: string; course_count: string };

export async function creatorCourseReuse(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const { cursor, limit } = parse(pageInput, req.query);
  const result = await query<ResourceRow>(`
    WITH resources AS (
      SELECT content_id AS id, title
      FROM contents
      WHERE creator_user_id = $1 AND ($2::uuid IS NULL OR content_id > $2)
      ORDER BY content_id
      LIMIT $3
    ), versions AS (
      SELECT v.content_id, v.content_version_id
      FROM content_versions v JOIN resources r ON r.id = v.content_id
    ), saved_courses AS (
      SELECT v.content_id, cr.course_id
      FROM versions v
      JOIN course_run_content_resources link USING (content_version_id)
      JOIN course_runs cr USING (course_run_id)
      UNION
      SELECT v.content_id, cm.course_id
      FROM versions v
      JOIN course_module_contents link USING (content_version_id)
      JOIN course_modules cm USING (module_id)
      UNION
      SELECT v.content_id, cm.course_id
      FROM versions v
      JOIN content_licenses cl USING (content_version_id)
      JOIN course_module_contents link USING (content_license_id)
      JOIN course_modules cm USING (module_id)
      WHERE link.content_version_id IS NULL
    )
    SELECT r.id, r.title, count(s.course_id)::text AS course_count
    FROM resources r LEFT JOIN saved_courses s ON s.content_id = r.id
    GROUP BY r.id, r.title
    ORDER BY r.id`, [actor.id, cursor ?? null, limit + 1]);

  const hasNext = result.rows.length > limit;
  const items = result.rows.slice(0, limit).map(row => ({
    id: row.id,
    title: row.title,
    courseCount: safeMetric(row.course_count, 'course reuse'),
  }));
  return ok(res, items, 200, { hasNext, nextCursor: hasNext ? items[items.length - 1].id : null });
}
