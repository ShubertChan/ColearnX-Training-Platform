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
  // Null for an event raised by a background job rather than a request, where
  // there is no client address to fingerprint.
  ipHash: string | null;
  uaHash: string | null;
  requestId: string | null;
};

/**
 * Fingerprint for an event raised by a scheduled job (W7 ledger audit and risk
 * sweep), not by a request. No IP, user agent or request id exists, so all
 * three are null and actor_ip_hash / actor_ua_hash are stored NULL.
 */
export const systemFingerprint = (): RequestFingerprint => ({ ipHash: null, uaHash: null, requestId: null });

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

// Alerts dispatched but not yet settled. A request path never waits on these;
// a batch job does (drainSecurityAlerts) before closing its connections, so
// that a finding's alert is not cut off by the process exiting.
const pendingAlerts = new Set<Promise<void>>();

export async function drainSecurityAlerts(): Promise<void> {
  while (pendingAlerts.size) await Promise.allSettled([...pendingAlerts]);
}

/**
 * Writes one row to security_events and PROPAGATES a write failure.
 *
 * It never joins the caller's transaction (`query` takes its own pooled
 * connection), so a business rollback leaves the event in place -- the whole
 * reason this table is separate from admin_action_logs. The outbound alert is
 * detached because the alert channel is a third party over the network and a
 * slow webhook must not add its latency to the caller.
 *
 * Unlike recordSecurityEvent below, this throws if the INSERT fails. A caller
 * whose entire job is to record events (the W7 ledger audit and risk sweep)
 * must be able to tell a lost write from a successful one, rather than reporting
 * success while the finding silently vanished.
 */
export async function persistSecurityEvent(
  fingerprint: RequestFingerprint,
  input: SecurityEventInput,
): Promise<void> {
  const severity = input.severity ?? defaultSeverity(input.type);
  const context = sanitiseContext(input.context ?? {});
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

  if (severity >= env.SECURITY_ALERT_MIN_SEVERITY) {
    // Detached on purpose: the alert is best-effort, so its failure is
    // swallowed and never masks or fails the awaited INSERT above.
    const alert = dispatchSecurityAlert({
      type: input.type,
      severity,
      actorUserId: input.actorUserId ?? null,
      requestId: fingerprint.requestId,
      context,
    }).catch(() => { /* best-effort alert; the recorded row is what matters */ });
    pendingAlerts.add(alert);
    void alert.finally(() => pendingAlerts.delete(alert));
  }
}

/**
 * Records a security event on a request path, where it must NEVER throw: a
 * failure to record telemetry must not turn a handled 401 into an unhandled
 * 500, nor abort a login that was otherwise going to succeed. The failure is
 * reported on the request logger and counted as a gap, not propagated.
 *
 * Background jobs do not use this -- they call persistSecurityEvent and handle
 * the failure themselves, because for them a lost write is the failure.
 */
export async function recordSecurityEvent(
  fingerprint: RequestFingerprint,
  input: SecurityEventInput,
  res?: Response,
): Promise<void> {
  try {
    await persistSecurityEvent(fingerprint, input);
  } catch (error) {
    res?.locals.log?.error(
      { err: error, eventType: input.type, requestId: fingerprint.requestId },
      'Failed to record security event',
    );
  }
}
