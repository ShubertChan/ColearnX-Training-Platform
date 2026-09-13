import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../db/database.js';
import { ApiError, ok } from '../lib/http.js';
import { resolveUtcDateRange } from '../lib/reporting-dates.js';
import { parse } from '../lib/validation.js';

const optionalText = (max: number) => z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().max(max).optional(),
);
const auditListInput = z.object({
  from: optionalText(10),
  to: optionalText(10),
  search: optionalText(200),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: optionalText(1_500),
  page: z.coerce.number().int().min(1).max(1).optional(),
}).strict().superRefine((value, context) => {
  if (value.cursor && value.page !== undefined) context.addIssue({ code: 'custom', message: 'cursor and page cannot be combined.' });
});

type AuditCursor = { v: 1; filter: string; createdAt: string; id: string };
type AuditRow = {
  log_id: string;
  created_at: Date;
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

function encodeAuditCursor(row: AuditRow, filter: string) {
  return Buffer.from(JSON.stringify({ v: 1, filter, createdAt: row.created_at.toISOString(), id: row.log_id } satisfies AuditCursor)).toString('base64url');
}

function decodeAuditCursor(value: string | undefined, filter: string): AuditCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<AuditCursor>;
    if (parsed.v !== 1 || parsed.filter !== filter || typeof parsed.createdAt !== 'string' || Number.isNaN(Date.parse(parsed.createdAt)) || !z.string().uuid().safeParse(parsed.id).success) {
      throw new Error('invalid cursor');
    }
    return parsed as AuditCursor;
  } catch {
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
    `SELECT aal.log_id, aal.created_at, aal.actor_user_id, aal.action_type, aal.target_table,
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
