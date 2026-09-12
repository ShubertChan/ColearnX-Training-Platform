import { env } from '../config/env.js';
import type { SecurityEventType, SecuritySeverity } from './taxonomy.js';

export type SecurityAlert = {
  type: SecurityEventType;
  severity: SecuritySeverity;
  actorUserId: string | null;
  requestId: string | null;
  context: Record<string, unknown>;
};

const severityLabel: Record<SecuritySeverity, string> = {
  0: 'INFO', 1: 'LOW', 2: 'MEDIUM', 3: 'HIGH', 4: 'CRITICAL',
};

/**
 * Simple in-process deduplication.  A credential-stuffing run produces
 * thousands of lockouts a minute; without this, the alert channel becomes the
 * outage.  Each (type, actor) pair alerts at most once per window -- the
 * events themselves are all still in the ledger, only the notification is
 * collapsed.
 *
 * In-process state is the correct scope for now because the API runs as a
 * single instance.  W5 moves rate limiting to Redis; this should move with it,
 * and the comment is here so that migration is not forgotten.
 */
const recentAlerts = new Map<string, number>();
const dedupeWindowMs = 5 * 60 * 1000;

function shouldSend(alert: SecurityAlert, now: number) {
  const key = `${alert.type}:${alert.actorUserId ?? 'anonymous'}`;
  const last = recentAlerts.get(key);
  if (last !== undefined && now - last < dedupeWindowMs) return false;
  recentAlerts.set(key, now);
  // Bounded cleanup: drop entries that can no longer suppress anything.
  if (recentAlerts.size > 1000) {
    for (const [existing, at] of recentAlerts) {
      if (now - at >= dedupeWindowMs) recentAlerts.delete(existing);
    }
  }
  return true;
}

export async function dispatchSecurityAlert(alert: SecurityAlert): Promise<void> {
  if (!env.SECURITY_ALERT_WEBHOOK_URL) return;
  if (!shouldSend(alert, Date.now())) return;

  // The payload carries no raw identifier: actorUserId is an opaque UUID and
  // context has already passed sanitiseContext. Alert channels are commonly
  // third-party chat services with weaker retention guarantees than the
  // database, so nothing extra is added here.
  const body = {
    text: `[CoLearnX ${severityLabel[alert.severity]}] ${alert.type}`,
    environment: env.NODE_ENV,
    eventType: alert.type,
    severity: alert.severity,
    actorUserId: alert.actorUserId,
    requestId: alert.requestId,
    context: alert.context,
    occurredAt: new Date().toISOString(),
  };

  const response = await fetch(env.SECURITY_ALERT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Alert webhook responded ${response.status}`);
}

/** Test seam: lets the dedupe window be reset between cases. */
export function resetAlertDeduplication() {
  recentAlerts.clear();
}
