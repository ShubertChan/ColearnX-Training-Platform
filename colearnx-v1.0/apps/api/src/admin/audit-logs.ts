import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../db/database.js';
import { ApiError, ok } from '../lib/http.js';
import { isExactUtcTimestamp, isLegacyUtcTimestamp } from '../lib/pagination-timestamps.js';
import { resolveUtcDateRange } from '../lib/reporting-dates.js';
import { optionalTrimmedText } from '../lib/reporting-query.js';
import { parse } from '../lib/validation.js';

const auditListInput = z.object({
  from: optionalTrimmedText(10),
  to: optionalTrimmedText(10),
  search: optionalTrimmedText(200),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: optionalTrimmedText(1_500),
  page: z.coerce.number().int().min(1).max(1).optional(),
}).strict().superRefine((value, context) => {
  if (value.cursor && value.page !== undefined) context.addIssue({ code: 'custom', message: 'cursor and page cannot be combined.' });
});

type AuditCursor = { v: 2; filter: string; createdAt: string; id: string };
type AuditRow = {
  log_id: string;
  created_at: Date;
  cursor_created_at: string;
  actor_user_id: string | null;
  action_type: string;
  target_table: string;
  target_record_id: string;
  request_id: string | null;
  reason: string | null;
};

function filterFingerprint(input: { from: string; to: string; search?: string }) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function redactAuditReason(value: string | null) {
  if (!value) return null;
  return value
    .replace(/\b(password|passphrase|token|secret|api[_ -]?key|authorization)\s*[:=]\s*\S+/gi, '$1: [redacted]')
    .slice(0, 500);
}

export function encodeAuditCursor(row: Pick<AuditRow, 'log_id' | 'cursor_created_at'>, filter: string) {
  return Buffer.from(JSON.stringify({ v: 2, filter, createdAt: row.cursor_created_at, id: row.log_id } satisfies AuditCursor)).toString('base64url');
}

export function decodeAuditCursor(value: string | undefined, filter: string): AuditCursor | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (!/^[A-Za-z0-9_-]+$/.test(value) || decoded.toString('base64url') !== value) throw new Error('invalid cursor');
    const parsed = JSON.parse(decoded.toString('utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || parsed.filter !== filter || !z.string().uuid().safeParse(parsed.id).success) {
      throw new Error('invalid cursor');
    }
    if (parsed.v === 1 && isLegacyUtcTimestamp(parsed.createdAt)) {
      throw new ApiError(400, 'CURSOR_RESTART_REQUIRED', 'This audit cursor has expired. Restart pagination.', { cursor: 'Restart audit pagination from the first page.' });
    }
    if (parsed.v !== 2 || !isExactUtcTimestamp(parsed.createdAt)) {
      throw new Error('invalid cursor');
    }
    return parsed as AuditCursor;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'VALIDATION_ERROR', 'The request is invalid.', { cursor: 'Invalid audit cursor.' });
  }
}

export async function listAuditLogs(req: Request, res: Response) {
  const input = parse(auditListInput, req.query);
  const range = resolveUtcDateRange(input);
  const filter = filterFingerprint({ ...range, search: input.search });
  const cursor = decodeAuditCursor(input.cursor, filter);
  // Escape the ILIKE metacharacters so a search box remains literal, bounded
  // text rather than a caller-controlled wildcard expression.
  const search = input.search ? `%${input.search.replace(/[\\%_]/g, '\\$&')}%` : null;
  const values: unknown[] = [range.from, range.to, search];
  let cursorClause = '';
  if (cursor) {
    values.push(cursor.createdAt, cursor.id);
    cursorClause = ' AND (aal.created_at < $4::timestamptz OR (aal.created_at = $4::timestamptz AND aal.log_id < $5::uuid))';
  }
  values.push(input.limit + 1);
  const result = await query<AuditRow>(
    `SELECT aal.log_id, aal.created_at,
            to_char(aal.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
            aal.actor_user_id, aal.action_type, aal.target_table,
            aal.target_record_id, aal.request_id, aal.details_json ->> 'reason' AS reason
       FROM admin_action_logs aal
      WHERE aal.created_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
        AND aal.created_at < (($2::date + 1)::timestamp AT TIME ZONE 'UTC')
        AND ($3::text IS NULL OR aal.action_type ILIKE $3 ESCAPE '\\'
          OR aal.target_record_id ILIKE $3 ESCAPE '\\'
          OR COALESCE(aal.request_id::text, '') ILIKE $3 ESCAPE '\\'
          OR COALESCE(aal.details_json ->> 'reason', '') ILIKE $3 ESCAPE '\\')${cursorClause}
      ORDER BY aal.created_at DESC, aal.log_id DESC
      LIMIT $${values.length}`,
    values,
  );
  const records = result.rows.slice(0, input.limit).map((row) => ({
    id: row.log_id,
    createdAt: row.created_at.toISOString(),
    actorId: row.actor_user_id,
    action: row.action_type,
    targetTable: row.target_table,
    targetId: row.target_record_id,
    requestId: row.request_id,
    reason: redactAuditReason(row.reason),
  }));
  const hasNext = result.rows.length > input.limit;
  return ok(res, records, 200, {
    from: range.from,
    to: range.to,
    hasNext,
    nextCursor: hasNext ? encodeAuditCursor(result.rows[input.limit - 1], filter) : null,
  });
}
