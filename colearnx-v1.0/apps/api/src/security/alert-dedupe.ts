import { getRedis } from '../lib/redis.js';
import type { SecurityAlert } from './alerts.js';

export const dedupeWindowMs = 5 * 60 * 1000;

/**
 * Deduplicates alerts so a credential-stuffing run (thousands of lockouts a
 * minute) cannot turn the alert channel itself into the outage. Each
 * (type, actor) pair alerts at most once per window; the events are all still
 * in the ledger, only the notification is collapsed.
 *
 * W5: the dedup state moved from a per-process Map to Redis so it is correct
 * once the API runs as more than one instance -- the same migration the rate
 * limiter made, and the reason `security/alerts.ts` was flagged to move with
 * it. `SET key 1 PX <window> NX` is atomic and returns 'OK' only to the first
 * caller inside the window across every instance.
 *
 * FALLBACK: if Redis is not configured, or a command fails mid-outage, it uses
 * the in-process Map. That is exactly correct for a single instance, and on a
 * multi-instance outage it errs toward SENDING a duplicate rather than
 * silently dropping a security alert.
 *
 * This lives in its own module (not `alerts.ts`) so the dedup logic can be unit
 * tested without loading `alerts.ts`'s `config/env` dependency. `getRedisFn` is
 * injected so the test drives both the Redis and the fallback path.
 */
export function makeAlertDeduper(getRedisFn: typeof getRedis = getRedis) {
  const recentAlerts = new Map<string, number>();
  return async function shouldSend(alert: SecurityAlert, now: number): Promise<boolean> {
    const key = `${alert.type}:${alert.actorUserId ?? 'anonymous'}`;
    const redis = getRedisFn();
    if (redis) {
      try {
        const result = await redis.set(`alert-dedup:${key}`, '1', 'PX', dedupeWindowMs, 'NX');
        return result === 'OK';
      } catch {
        // fall through to the in-process fallback below
      }
    }
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
  };
}
