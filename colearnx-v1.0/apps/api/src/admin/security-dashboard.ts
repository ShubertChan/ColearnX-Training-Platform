import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApiError, ok } from '../lib/http.js';
import { isExactUtcTimestamp } from '../lib/pagination-timestamps.js';
import { resolveUtcDateRange, utcDates, type UtcDateRange } from '../lib/reporting-dates.js';
import { optionalTrimmedText, safeMetric, withReadOnlySnapshot } from '../lib/reporting-query.js';
import { parse } from '../lib/validation.js';
import { securityEventSeverity, type SecuritySeverity } from '../security/taxonomy.js';

// The dashboard reads the F-12 ledger (security_events). The table, its indexes
// and the reserved risk_score/rule_hits columns were provisioned in migration
// 009 specifically so this view needs no schema change (see HANDOVER.md §4).
//
// Two endpoints, both admin + MFA + step-up gated in app.ts:
//   GET /admin/security/summary  -- aggregates for the KPI tiles and trend
//   GET /admin/security/events   -- the keyset-paginated event stream
//
// What never leaves this module: a raw IP or user agent. The ledger only holds
// HMAC fingerprints of those (F-05), and even those are truncated to a short,
// non-reversible correlation prefix before they reach the client. context_json
// was already stripped of secrets and raw identifiers at write time
// (security/taxonomy.ts), so it is forwarded as stored.

const severityKeys: number[] = [0, 1, 2, 3, 4];
const knownEventTypes = new Set(Object.keys(securityEventSeverity));
// The partial index security_events_severe_recent_idx covers severity >= 3,
// which is the view an operator triaging alerts opens first.
export const SEVERE_THRESHOLD = 3;
// A short slice of the HMAC fingerprint: enough to say "these two events came
// from the same source" without shipping the full digest. The digest is already
// keyed with SECURITY_HASH_PEPPER and not reversible; this is defence in depth.
const SOURCE_PREFIX_LENGTH = 12;

// --- input validation ------------------------------------------------------

const eventType = optionalTrimmedText(80).refine(
  (value) => value === undefined || knownEventTypes.has(value),
  { message: 'Unknown security event type.' },
);

const summaryInput = z.object({
  from: optionalTrimmedText(10),
  to: optionalTrimmedText(10),
}).strict();

const eventsInput = z.object({
  from: optionalTrimmedText(10),
  to: optionalTrimmedText(10),
  type: eventType,
  minSeverity: z.coerce.number().int().min(0).max(4).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: optionalTrimmedText(1_500),
  page: z.coerce.number().int().min(1).max(1).optional(),
}).strict().superRefine((value, context) => {
  if (value.cursor && value.page !== undefined) {
    context.addIssue({ code: 'custom', message: 'cursor and page cannot be combined.' });
  }
});

type EventsFilter = { from: string; to: string; type?: string; minSeverity: number };

// --- cursor (keyset on occurred_at DESC, security_event_id DESC) -----------

type SecurityCursor = { v: 1; filter: string; occurredAt: string; id: string };

export function securityFilterFingerprint(filter: EventsFilter) {
  return createHash('sha256').update(JSON.stringify(filter)).digest('hex');
}

export function encodeSecurityCursor(row: { id: string; cursorOccurredAt: string }, filter: string) {
  return Buffer.from(
    JSON.stringify({ v: 1, filter, occurredAt: row.cursorOccurredAt, id: row.id } satisfies SecurityCursor),
  ).toString('base64url');
}

export function decodeSecurityCursor(value: string | undefined, filter: string): SecurityCursor | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (!/^[A-Za-z0-9_-]+$/.test(value) || decoded.toString('base64url') !== value) throw new Error('invalid cursor');
    const parsed = JSON.parse(decoded.toString('utf8')) as Record<string, unknown>;
    if (
      !parsed || typeof parsed !== 'object' || parsed.v !== 1 || parsed.filter !== filter
      || !z.string().uuid().safeParse(parsed.id).success || !isExactUtcTimestamp(parsed.occurredAt)
    ) {
      throw new Error('invalid cursor');
    }
    return parsed as SecurityCursor;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'VALIDATION_ERROR', 'The request is invalid.', { cursor: 'Invalid security cursor.' });
  }
}

// --- pure shaping helpers (unit-tested without a database) ------------------

export type DailyCount = { date: string; total: number; severe: number };

/**
 * A GROUP BY only returns the days that had events. A trend line with gaps
 * misreads as missing data, so every UTC day in the window is present, missing
 * ones as zero.
 */
export function fillDailySeries(
  rows: Array<{ d: string; total: string; severe: string }>,
  range: UtcDateRange,
): DailyCount[] {
  const byDate = new Map(rows.map((row) => [row.d, row]));
  return utcDates(range).map((date) => {
    const row = byDate.get(date);
    return {
      date,
      total: row ? safeMetric(row.total, 'daily total') : 0,
      severe: row ? safeMetric(row.severe, 'daily severe') : 0,
    };
  });
}

const HIGHLIGHT_TYPES = {
  failedLogins: 'auth.login_failed',
  accountsLocked: 'auth.account_locked',
  rateLimited: 'access.rate_limited',
  forbidden: 'access.forbidden',
  breachUnavailable: 'auth.breach_check_unavailable',
  mfaDisabled: 'auth.mfa_disabled',
  refreshReused: 'session.refresh_reused',
} as const;

export function summariseHighlights(byType: Array<{ type: string; count: number }>) {
  const counts = new Map(byType.map((row) => [row.type, row.count]));
  const highlights: Record<string, number> = {};
  for (const [label, type] of Object.entries(HIGHLIGHT_TYPES)) highlights[label] = counts.get(type) ?? 0;
  return highlights;
}

// --- row types -------------------------------------------------------------

type SeverityRow = { severity: SecuritySeverity; n: string };
type TypeRow = { event_type: string; n: string; sev: SecuritySeverity };
type DailyRow = { d: string; total: string; severe: string };
type DistinctRow = { sources: string; targeted: string };
type EventRow = {
  security_event_id: string;
  occurred_at: Date;
  cursor_occurred_at: string;
  event_type: string;
  severity: SecuritySeverity;
  decision: string;
  actor_user_id: string | null;
  target_user_id: string | null;
  request_id: string | null;
  risk_score: number;
  rule_hits: string[];
  context_json: Record<string, unknown>;
  source_prefix: string | null;
};

function rangeClause(alias = '') {
  const column = alias ? `${alias}.occurred_at` : 'occurred_at';
  return `${column} >= ($1::date::timestamp AT TIME ZONE 'UTC') AND ${column} < (($2::date + 1)::timestamp AT TIME ZONE 'UTC')`;
}

// --- GET /admin/security/summary -------------------------------------------

export async function securitySummary(req: Request, res: Response) {
  const input = parse(summaryInput, req.query);
  const range = resolveUtcDateRange(input);
  const bounds = [range.from, range.to];

  const result = await withReadOnlySnapshot(async (client: PoolClient) => {
    const [severity, byType, daily, distinct] = await Promise.all([
      client.query<SeverityRow>(
        `SELECT severity, count(*)::text AS n FROM security_events WHERE ${rangeClause()} GROUP BY severity`,
        bounds,
      ),
      client.query<TypeRow>(
        `SELECT event_type, count(*)::text AS n, max(severity) AS sev
           FROM security_events WHERE ${rangeClause()}
          GROUP BY event_type ORDER BY count(*) DESC, event_type ASC`,
        bounds,
      ),
      client.query<DailyRow>(
        `SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d,
                count(*)::text AS total,
                count(*) FILTER (WHERE severity >= ${SEVERE_THRESHOLD})::text AS severe
           FROM security_events WHERE ${rangeClause()}
          GROUP BY d`,
        bounds,
      ),
      client.query<DistinctRow>(
        `SELECT count(DISTINCT actor_ip_hash)::text AS sources,
                count(DISTINCT actor_user_id) FILTER (WHERE actor_user_id IS NOT NULL AND severity >= 2)::text AS targeted
           FROM security_events WHERE ${rangeClause()}`,
        bounds,
      ),
    ]);
    return { severity, byType, daily, distinct };
  });

  const severityTotals: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const row of result.severity.rows) severityTotals[row.severity] = safeMetric(row.n, 'severity total');
  const total = severityKeys.reduce((sum, key) => sum + severityTotals[key], 0);
  const severe = severityKeys.filter((key) => key >= SEVERE_THRESHOLD).reduce((sum, key) => sum + severityTotals[key], 0);

  const byType = result.byType.rows.map((row) => ({
    type: row.event_type,
    count: safeMetric(row.n, 'event-type total'),
    severity: row.sev,
  }));
  const distinct = result.distinct.rows[0] ?? { sources: '0', targeted: '0' };

  return ok(res, {
    range,
    total,
    severe,
    severityTotals,
    highlights: {
      ...summariseHighlights(byType),
      distinctSources: safeMetric(distinct.sources, 'distinct sources'),
      accountsTargeted: safeMetric(distinct.targeted, 'accounts targeted'),
    },
    byType: byType.slice(0, 12),
    daily: fillDailySeries(result.daily.rows, range),
  });
}

// --- GET /admin/security/events --------------------------------------------

export async function listSecurityEvents(req: Request, res: Response) {
  const input = parse(eventsInput, req.query);
  const range = resolveUtcDateRange(input);
  const filter: EventsFilter = { from: range.from, to: range.to, type: input.type, minSeverity: input.minSeverity };
  const fingerprint = securityFilterFingerprint(filter);
  const cursor = decodeSecurityCursor(input.cursor, fingerprint);

  const values: unknown[] = [range.from, range.to, input.type ?? null, input.minSeverity];
  let cursorClause = '';
  if (cursor) {
    values.push(cursor.occurredAt, cursor.id);
    cursorClause = ' AND (se.occurred_at < $5::timestamptz OR (se.occurred_at = $5::timestamptz AND se.security_event_id < $6::uuid))';
  }
  values.push(input.limit + 1);

  const result = await withReadOnlySnapshot((client: PoolClient) => client.query<EventRow>(
    `SELECT se.security_event_id, se.occurred_at,
            to_char(se.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_occurred_at,
            se.event_type, se.severity, se.decision,
            se.actor_user_id, se.target_user_id, se.request_id,
            se.risk_score, se.rule_hits, se.context_json,
            left(se.actor_ip_hash, ${SOURCE_PREFIX_LENGTH}) AS source_prefix
       FROM security_events se
      WHERE ${rangeClause('se')}
        AND ($3::text IS NULL OR se.event_type = $3)
        AND se.severity >= $4::smallint${cursorClause}
      ORDER BY se.occurred_at DESC, se.security_event_id DESC
      LIMIT $${values.length}`,
    values,
  ));

  const records = result.rows.slice(0, input.limit).map((row) => ({
    id: row.security_event_id,
    occurredAt: row.occurred_at.toISOString(),
    type: row.event_type,
    severity: row.severity,
    decision: row.decision,
    actorId: row.actor_user_id,
    targetId: row.target_user_id,
    requestId: row.request_id,
    riskScore: row.risk_score,
    ruleHits: row.rule_hits,
    source: row.source_prefix,
    context: row.context_json,
  }));
  const hasNext = result.rows.length > input.limit;
  const lastRow = result.rows[input.limit - 1];
  return ok(res, records, 200, {
    from: range.from,
    to: range.to,
    minSeverity: input.minSeverity,
    type: input.type ?? null,
    hasNext,
    nextCursor: hasNext && lastRow
      ? encodeSecurityCursor({ id: lastRow.security_event_id, cursorOccurredAt: lastRow.cursor_occurred_at }, fingerprint)
      : null,
  });
}
