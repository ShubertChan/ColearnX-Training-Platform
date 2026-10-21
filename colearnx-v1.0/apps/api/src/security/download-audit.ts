// W8 (threat model F-20): presigned download links can be forwarded.
//
// A signed R2 URL is a bearer credential: whoever holds it can fetch the file
// until it expires, and R2 does not tell the API when it is used. What the API
// CAN see is every time it issues one -- to which account, for which file, from
// which network. This module makes that visible and turns it into a signal:
//
//   * recordDownloadIssued (request path) writes one content.download_issued
//     row per signed URL into the append-only security ledger;
//   * assessDownloadPattern (pure) decides whether one account's issuance
//     pattern for one file looks like a shared or resold account;
//   * runDownloadAudit (batch) aggregates the ledger and records a
//     content.download_anomaly event per finding, for the W6 monitor.
//
// Detection, not enforcement -- the same stance as the W7 risk sweep: a family
// downloading from home and from a phone must not be locked out by a guess.
// The remaining exposure (a link replayed inside its TTL, 300 s by default) is
// bounded by R2_SIGNED_DOWNLOAD_TTL_SECONDS and stated in W8-verification.md.

import type { Request, Response } from 'express';
import { recordSecurityEvent, securityContext } from './events.js';
import type { SecuritySeverity } from './taxonomy.js';

export async function recordDownloadIssued(req: Request, res: Response, actorUserId: string,
  details: { assetId: string; assetKind: 'content' | 'course'; mode: 'attachment' | 'inline' }) {
  await recordSecurityEvent(securityContext(req, res), {
    type: 'content.download_issued',
    actorUserId,
    context: details,
  }, res);
}

// --- pure rule -------------------------------------------------------------

export type DownloadPattern = {
  actorUserId: string;
  assetId: string;
  assetKind: string;
  // Signed URLs issued to this account for this file in the window.
  issued: number;
  // Distinct client-network fingerprints those requests came from.
  networks: number;
};

export type DownloadVerdict = {
  actorUserId: string;
  assetId: string;
  riskScore: number;
  severity: SecuritySeverity;
  ruleHits: string[];
  reasons: string[];
};

// One person plausibly fetches a file from home, work and a phone. Four or
// more distinct networks for the SAME file in a day is the shape of a shared
// login. Thirty links for one file in a day is scripted re-issuing.
export const DISTINCT_NETWORK_THRESHOLD = 4;
export const ISSUE_VOLUME_THRESHOLD = 30;

export function assessDownloadPattern(pattern: DownloadPattern): DownloadVerdict | null {
  const ruleHits: string[] = [];
  const reasons: string[] = [];
  let riskScore = 0;
  if (pattern.networks >= DISTINCT_NETWORK_THRESHOLD) {
    ruleHits.push('download_many_networks');
    reasons.push(`links for one file requested from ${pattern.networks} networks`);
    riskScore += 50;
  }
  if (pattern.issued >= ISSUE_VOLUME_THRESHOLD) {
    ruleHits.push('download_volume');
    reasons.push(`${pattern.issued} links issued for one file`);
    riskScore += 30;
  }
  if (!ruleHits.length) return null;
  // Medium, never paging: this is a lead for an operator to look at, and an
  // unattended job must not depend on the alert channel to exit cleanly.
  return { actorUserId: pattern.actorUserId, assetId: pattern.assetId, riskScore, severity: 2, ruleHits, reasons };
}

// --- batch -----------------------------------------------------------------

export const DOWNLOAD_PATTERN_SQL = `
  SELECT actor_user_id::text AS actor,
         context_json->>'assetId' AS asset_id,
         context_json->>'assetKind' AS asset_kind,
         count(*)::text AS issued,
         count(DISTINCT actor_ip_hash)::text AS networks
    FROM security_events
   WHERE event_type = 'content.download_issued'
     AND actor_user_id IS NOT NULL
     AND occurred_at > now() - ($1 * interval '1 hour')
   GROUP BY 1, 2, 3
  HAVING count(DISTINCT actor_ip_hash) >= $2 OR count(*) >= $3`;

type AuditClient = {
  query(sql: string, parameters?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(): void;
};
export type DownloadAuditPool = { connect(): Promise<AuditClient> };
export type DownloadAuditEmit = (verdict: DownloadVerdict, pattern: DownloadPattern) => Promise<void>;
export type DownloadAuditSummary = { patternsAssessed: number; flagged: number; recordFailures: number };

type PatternRow = { actor: string; asset_id: string | null; asset_kind: string | null; issued: string; networks: string };

function toCount(value: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Aggregate count is not a non-negative safe integer: ${value}`);
  return parsed;
}

export async function runDownloadAudit(pool: DownloadAuditPool, emit: DownloadAuditEmit,
  options: { windowHours?: number } = {}): Promise<DownloadAuditSummary> {
  const windowHours = options.windowHours ?? 24;
  const client = await pool.connect();
  try {
    const rows = (await client.query(DOWNLOAD_PATTERN_SQL,
      [windowHours, DISTINCT_NETWORK_THRESHOLD, ISSUE_VOLUME_THRESHOLD])).rows as PatternRow[];
    let flagged = 0;
    let recordFailures = 0;
    for (const row of rows) {
      if (!row.asset_id) continue;
      const pattern: DownloadPattern = {
        actorUserId: row.actor, assetId: row.asset_id, assetKind: row.asset_kind ?? 'unknown',
        issued: toCount(row.issued), networks: toCount(row.networks),
      };
      const verdict = assessDownloadPattern(pattern);
      if (!verdict) continue;
      flagged += 1;
      try {
        await emit(verdict, pattern);
      } catch {
        // Same contract as the W7 jobs: a lost finding is counted and the
        // runner exits non-zero, never reported as a clean run.
        recordFailures += 1;
      }
    }
    return { patternsAssessed: rows.length, flagged, recordFailures };
  } finally {
    client.release();
  }
}
