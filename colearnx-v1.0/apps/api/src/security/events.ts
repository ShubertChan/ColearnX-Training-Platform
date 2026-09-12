import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { query } from '../db/database.js';
import { dispatchSecurityAlert } from './alerts.js';
import { ipFingerprint, userAgentFingerprint } from './fingerprint.js';
import {
  defaultSeverity,
  sanitiseContext,
  type SecurityDecision,
  type SecurityEventType,
  type SecuritySeverity,
} from './taxonomy.js';

export type RequestFingerprint = {
  ipHash: string;
  uaHash: string | null;
  requestId: string | null;
};

export type SecurityEventInput = {
  type: SecurityEventType;
  severity?: SecuritySeverity;
  actorUserId?: string | null;
  targetUserId?: string | null;
  decision?: SecurityDecision;
  riskScore?: number;
  ruleHits?: string[];
  context?: Record<string, unknown>;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Derives the request-scoped identifiers once, so a handler that records two
 * events does not hash the same address twice.
 */
export function securityContext(req: Request, res: Response): RequestFingerprint {
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : null;
  return {
    ipHash: ipFingerprint(req.ip, env.SECURITY_HASH_PEPPER),
    uaHash: userAgentFingerprint(req.get('user-agent'), env.SECURITY_HASH_PEPPER),
    requestId: requestId && uuidPattern.test(requestId) ? requestId : null,
  };
}

/**
 * Writes one row to security_events.
 *
 * Two properties matter more than throughput here:
 *
 *   1. It never throws.  A failure to record telemetry must not turn a handled
 *      401 into an unhandled 500, and must not abort a login that was
 *      otherwise going to succeed.  Failures are reported on the request
 *      logger and counted as a gap, not propagated.
 *
 *   2. It never joins the caller's transaction.  `query` takes its own
 *      connection from the pool, so a business rollback -- or an ApiError
 *      thrown immediately after this call -- leaves the event in place.  This
 *      is the whole reason the table exists separately from
 *      admin_action_logs, which does roll back with its transaction.
 *
 * It is awaited rather than fired and forgotten: an event that is lost because
 * the process exited mid-flush is an event that was never worth writing, and
 * a single indexed INSERT on a pooled connection costs about a millisecond.
 * The outbound alert, which can take seconds, is the part that is detached.
 */
export async function recordSecurityEvent(
  fingerprint: RequestFingerprint,
  input: SecurityEventInput,
  res?: Response,
): Promise<void> {
  const severity = input.severity ?? defaultSeverity(input.type);
  const context = sanitiseContext(input.context ?? {});
  try {
    await query(
      `INSERT INTO security_events
         (event_type, severity, actor_user_id, target_user_id,
          actor_ip_hash, actor_ua_hash, request_id,
          risk_score, rule_hits, decision, context_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        input.type,
        severity,
        input.actorUserId ?? null,
        input.targetUserId ?? null,
        fingerprint.ipHash,
        fingerprint.uaHash,
        fingerprint.requestId,
        Math.min(100, Math.max(0, Math.round(input.riskScore ?? 0))),
        input.ruleHits ?? [],
        input.decision ?? 'allow',
        JSON.stringify(context),
      ],
    );
  } catch (error) {
    res?.locals.log?.error(
      { err: error, eventType: input.type, requestId: fingerprint.requestId },
      'Failed to record security event',
    );
    return;
  }

  if (severity >= env.SECURITY_ALERT_MIN_SEVERITY) {
    // Detached on purpose: the alert channel is a third party over the
    // network. A slow or unreachable webhook must not add its latency to a
    // user-facing login response.
    void dispatchSecurityAlert({
      type: input.type,
      severity,
      actorUserId: input.actorUserId ?? null,
      requestId: fingerprint.requestId,
      context,
    }).catch((error) => {
      res?.locals.log?.warn({ err: error, eventType: input.type }, 'Security alert dispatch failed');
    });
  }
}
