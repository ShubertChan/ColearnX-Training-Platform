import { Redis } from 'ioredis';

/**
 * Shared Redis client for the W5 distributed controls (rate limiting and alert
 * deduplication).
 *
 * DESIGN: Redis is OPTIONAL. When `REDIS_URL` is empty -- local development,
 * the current single-instance deployment, the unit suite -- this returns null
 * and every caller falls back to its in-process behaviour, so nothing changes.
 * Redis only becomes the source of truth once an operator sets `REDIS_URL`,
 * which is what makes rate limiting and alert dedup correct across more than
 * one API instance.
 *
 * `REDIS_URL` is read from `process.env` directly rather than from `config/env`
 * on purpose: it keeps this module (and the limiter / dedup units that import
 * it) free of the full environment-validation load-time dependency, so those
 * pure units run without a database configured. The value is still validated
 * app-wide, because `config/env.ts` parses `REDIS_URL` when the server starts.
 *
 * FAILURE MODE: fail open. `enableOfflineQueue: false` plus a single retry means
 * a command issued while Redis is unreachable rejects promptly instead of
 * hanging; the callers catch that rejection and allow the request / send the
 * alert. A rate-limit backend outage must never become an auth outage, and a
 * dedup backend outage must never silence a security alert.
 */
let cached: Redis | null | undefined;

export function getRedis(): Redis | null {
  if (cached !== undefined) return cached;
  const url = process.env.REDIS_URL;
  if (!url) {
    cached = null;
    return cached;
  }
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 3_000,
    connectionName: 'colearnx-api',
  });
  // The error event must have a listener or ioredis prints to stderr on every
  // reconnect attempt. The command paths already fail open, so nothing else is
  // needed here.
  client.on('error', () => {});
  cached = client;
  return cached;
}

/** Test seam: drops the memoised client so a test can install its own. */
export function resetRedisForTests(): void {
  cached = undefined;
}
