import { env } from '../config/env.js';
import { makeAlertDeduper } from './alert-dedupe.js';
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

// W5: the (type, actor) dedup now lives in Redis when configured, with a
// per-process fallback. The logic is in alert-dedupe.ts so it can be unit
// tested without this module's environment dependency.
const shouldSend = makeAlertDeduper();

export async function dispatchSecurityAlert(alert: SecurityAlert): Promise<void> {
  if (!env.SECURITY_ALERT_WEBHOOK_URL) return;
  if (!(await shouldSend(alert, Date.now()))) return;

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
