import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { query, withTransaction } from '../db/database.js';
import { completeIdempotency, reserveIdempotency } from '../lib/idempotency.js';
import { ApiError, ok } from '../lib/http.js';
import { isExactUtcTimestamp, isLegacyUtcTimestamp } from '../lib/pagination-timestamps.js';
import { idempotencyKey, parse, uuid } from '../lib/validation.js';

const reportStatus = z.enum(['pending', 'resolved', 'dismissed']);
const reportCategory = z.enum(['misleading', 'copyright', 'unsafe', 'other']);
const reportKind = z.enum(['course', 'content']);
const createReportInput = z.object({
  kind: reportKind,
  productId: uuid,
  category: reportCategory,
  reason: z.string().trim().min(10).max(4_000),
}).strict();
const decisionInput = z.object({
  decision: z.enum(['resolved', 'dismissed']),
  reason: z.string().trim().min(5).max(4_000),
}).strict();
const listReportsInput = z.object({
  status: reportStatus.default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.preprocess((value) => value === '' ? undefined : value, z.string().max(1_500).optional()),
  // Retained only for the existing first request. Cursor pagination must not
  // combine an offset with a cursor because that skips or duplicates records.
  page: z.coerce.number().int().min(1).max(1).optional(),
}).strict().superRefine((value, context) => {
  if (value.cursor && value.page !== undefined) {
    context.addIssue({ code: 'custom', message: 'cursor and page cannot be combined.' });
  }
});

type ReportCursor = {
  v: 2;
  status: z.infer<typeof reportStatus>;
  createdAt: string | null;
  id: string;
};

type ReportRow = {
  report_id: string;
  kind: string;
  product_id: string | null;
  title: string | null;
  reason: string;
  report_category: string | null;
  report_status: string;
  created_at: Date | null;
  cursor_created_at: string | null;
  reviewer_user_id: string | null;
  reviewed_at: Date | null;
  decision_reason: string | null;
  reporter_user_id: string;
  reporter_display_name: string | null;
  reviewer_display_name: string | null;
};

type ReportDto = {
  id: string;
  kind: string;
  productId: string | null;
  title: string | null;
  category: string;
  reason: string;
  status: string;
  createdAt: string | null;
  reporter: { id: string; displayName: string };
  reviewer: { id: string; displayName: string } | null;
  reviewedAt: string | null;
  decisionReason: string | null;
};

const reportSelect = `SELECT ur.report_id,
  CASE
    WHEN ur.target_course_id IS NOT NULL THEN 'course'
    WHEN ur.target_content_id IS NOT NULL THEN 'content'
    ELSE 'user'
  END AS kind,
  COALESCE(ur.target_course_run_id, ur.target_content_version_id, ur.target_course_id, ur.target_content_id)::text AS product_id,
  COALESCE(ur.target_title_snapshot, course.title, content.title, 'Unavailable marketplace item') AS title,
  ur.reason, ur.report_category, ur.report_status, ur.created_at,
  to_char(ur.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
  ur.reporter_user_id, ur.reviewer_user_id, ur.reviewed_at, ur.decision_reason,
  COALESCE(reporter_profile.display_name, reporter.full_name, 'Former member') AS reporter_display_name,
  COALESCE(reviewer_profile.display_name, reviewer.full_name, 'Former administrator') AS reviewer_display_name
  FROM user_reports ur
  LEFT JOIN courses course ON course.course_id = ur.target_course_id
  LEFT JOIN contents content ON content.content_id = ur.target_content_id
  LEFT JOIN users reporter ON reporter.user_id = ur.reporter_user_id
  LEFT JOIN profiles reporter_profile ON reporter_profile.user_id = reporter.user_id
  LEFT JOIN users reviewer ON reviewer.user_id = ur.reviewer_user_id
  LEFT JOIN profiles reviewer_profile ON reviewer_profile.user_id = reviewer.user_id`;

function toIso(value: Date | string | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function reportDto(row: ReportRow): ReportDto {
  return {
    id: row.report_id,
    kind: row.kind,
    productId: row.product_id,
    title: row.title,
    category: row.report_category ?? 'unknown',
    reason: row.reason,
    status: row.report_status,
    createdAt: toIso(row.created_at),
    reporter: { id: row.reporter_user_id, displayName: row.reporter_display_name ?? 'Former member' },
    reviewer: row.reviewer_user_id ? { id: row.reviewer_user_id, displayName: row.reviewer_display_name ?? 'Former administrator' } : null,
    reviewedAt: toIso(row.reviewed_at),
    decisionReason: row.decision_reason,
  };
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function encodeReportCursor(row: Pick<ReportRow, 'report_id' | 'cursor_created_at'>, status: z.infer<typeof reportStatus>) {
  const cursor: ReportCursor = { v: 2, status, createdAt: row.cursor_created_at, id: row.report_id };
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeReportCursor(value: string | undefined, status: z.infer<typeof reportStatus>): ReportCursor | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (!/^[A-Za-z0-9_-]+$/.test(value) || decoded.toString('base64url') !== value) throw new Error('invalid cursor');
    const parsed = JSON.parse(decoded.toString('utf8')) as Partial<Omit<ReportCursor, 'v'>> & { v?: number };
    if (!parsed || parsed.status !== status || !z.string().uuid().safeParse(parsed.id).success) {
      throw new Error('invalid cursor');
    }
    if (parsed.v === 1 && (parsed.createdAt === null || isLegacyUtcTimestamp(parsed.createdAt))) {
      throw new ApiError(400, 'CURSOR_RESTART_REQUIRED', 'The list cursor is from an older version. Reload the list from the first page.');
    }
    if (parsed.v !== 2 || !(parsed.createdAt === null || isExactUtcTimestamp(parsed.createdAt))) throw new Error('invalid cursor');
    return parsed as ReportCursor;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'CURSOR_RESTART_REQUIRED') throw error;
    throw new ApiError(400, 'VALIDATION_ERROR', 'The request is invalid.', { cursor: 'Invalid report cursor.' });
  }
}

async function getReport(client: PoolClient, id: string) {
  const result = await client.query<ReportRow>(`${reportSelect} WHERE ur.report_id = $1`, [id]);
  if (!result.rowCount) throw new ApiError(404, 'REPORT_NOT_FOUND', 'Report was not found.');
  return reportDto(result.rows[0]);
}

async function resolveTarget(client: PoolClient, kind: z.infer<typeof reportKind>, productId: string) {
  if (kind === 'course') {
    const result = await client.query<{ course_id: string; course_run_id: string; title: string }>(
      `SELECT c.course_id, cr.course_run_id, c.title
         FROM course_runs cr
         JOIN courses c ON c.course_id = cr.course_id
        WHERE cr.course_run_id = $1 AND cr.run_status = 'published' AND c.publication_status = 'published'
        FOR KEY SHARE OF cr, c`,
      [productId],
    );
    if (!result.rowCount) throw new ApiError(404, 'REPORT_TARGET_NOT_AVAILABLE', 'The requested marketplace item is not available.');
    return { courseId: result.rows[0].course_id, courseRunId: result.rows[0].course_run_id, contentId: null, contentVersionId: null, title: result.rows[0].title };
  }
  const result = await client.query<{ content_id: string; content_version_id: string; title: string }>(
    `SELECT c.content_id, cv.content_version_id, c.title
       FROM content_versions cv
       JOIN contents c ON c.content_id = cv.content_id
      WHERE cv.content_version_id = $1 AND cv.version_status = 'published' AND c.publication_status = 'published'
      FOR KEY SHARE OF cv, c`,
    [productId],
  );
  if (!result.rowCount) throw new ApiError(404, 'REPORT_TARGET_NOT_AVAILABLE', 'The requested marketplace item is not available.');
  return { courseId: null, courseRunId: null, contentId: result.rows[0].content_id, contentVersionId: result.rows[0].content_version_id, title: result.rows[0].title };
}

export async function createReport(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  if (!actor.roles.includes('member')) throw new ApiError(403, 'MEMBER_ROLE_REQUIRED', 'A member account is required to submit a report.');
  const input = parse(createReportInput, req.body);
  const key = parse(idempotencyKey, req.get('idempotency-key'));
  const request = { actorUserId: actor.id, operationScope: 'reports.create', key, fingerprint: fingerprint(input) };
  const report = await withTransaction(async (client) => {
    const replay = await reserveIdempotency<ReportDto>(client, request);
    if (replay) return replay;

    const target = await resolveTarget(client, input.kind, input.productId);
    const inserted = await client.query<{ report_id: string }>(
      `INSERT INTO user_reports
        (reporter_user_id, target_course_id, target_content_id, target_course_run_id, target_content_version_id,
         target_title_snapshot, reason, report_category, report_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
       ON CONFLICT DO NOTHING
       RETURNING report_id`,
      [actor.id, target.courseId, target.contentId, target.courseRunId, target.contentVersionId, target.title, input.reason, input.category],
    );
    if (!inserted.rowCount) {
      throw new ApiError(409, 'REPORT_ALREADY_PENDING', 'You already have a pending report for this marketplace item.');
    }
    const body = await getReport(client, inserted.rows[0].report_id);
    await completeIdempotency(client, request, 201, body);
    return body;
  });
  return ok(res, report, 201);
}

export async function listReports(req: Request, res: Response) {
  const input = parse(listReportsInput, req.query);
  const cursor = decodeReportCursor(input.cursor, input.status);
  const values: unknown[] = [input.status];
  let cursorClause = '';
  if (cursor) {
    values.push(cursor.createdAt, cursor.id);
    cursorClause = ` AND (
      ($2::timestamptz IS NULL AND ur.created_at IS NULL AND ur.report_id < $3::uuid)
      OR ($2::timestamptz IS NOT NULL AND (
        ur.created_at < $2::timestamptz
        OR (ur.created_at = $2::timestamptz AND ur.report_id < $3::uuid)
        OR ur.created_at IS NULL
      ))
    )`;
  }
  values.push(input.limit + 1);
  const result = await query<ReportRow>(
    `${reportSelect} WHERE ur.report_status = $1${cursorClause}
      ORDER BY ur.created_at DESC NULLS LAST, ur.report_id DESC LIMIT $${values.length}`,
    values,
  );
  const pageRows = result.rows.slice(0, input.limit);
  const rows = pageRows.map(reportDto);
  const hasNext = result.rows.length > input.limit;
  return ok(res, rows, 200, { hasNext, nextCursor: hasNext && pageRows.length ? encodeReportCursor(pageRows.at(-1)!, input.status) : null });
}

export async function decideReport(req: Request, res: Response) {
  const admin = res.locals.actor as Actor;
  const reportId = parse(uuid, req.params.id);
  const input = parse(decisionInput, req.body);
  const key = parse(idempotencyKey, req.get('idempotency-key'));
  const request = { actorUserId: admin.id, operationScope: 'reports.decision', key, fingerprint: fingerprint({ reportId, ...input }) };
  const report = await withTransaction(async (client) => {
    const replay = await reserveIdempotency<ReportDto>(client, request);
    if (replay) return replay;

    const locked = await client.query<{ report_status: string }>(
      'SELECT report_status FROM user_reports WHERE report_id = $1 FOR UPDATE', [reportId],
    );
    if (!locked.rowCount) throw new ApiError(404, 'REPORT_NOT_FOUND', 'Report was not found.');
    if (locked.rows[0].report_status !== 'pending') {
      throw new ApiError(409, 'REPORT_ALREADY_REVIEWED', 'This report has already been reviewed.');
    }
    await client.query(
      `UPDATE user_reports
          SET report_status = $2, reviewer_user_id = $3, reviewed_at = now(), decision_reason = $4, updated_at = now()
        WHERE report_id = $1`,
      [reportId, input.decision, admin.id, input.reason],
    );
    await client.query(
      `INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
       VALUES ($1, $2, 'user_reports', $3,
         jsonb_build_object('fromStatus', 'pending', 'toStatus', $4::text, 'reason', $5::text, 'outcome', 'success'), $6)`,
      [admin.id, input.decision === 'resolved' ? 'report.resolve' : 'report.dismiss', reportId, input.decision, input.reason, res.locals.requestId],
    );
    const body = await getReport(client, reportId);
    await completeIdempotency(client, request, 200, body);
    return body;
  });
  return ok(res, report);
}
