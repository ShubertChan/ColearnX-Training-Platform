/**
 * The event vocabulary.  Keeping it in one typed table rather than scattering
 * string literals across handlers means the dashboard, the alert thresholds
 * and the W7 rule engine all agree on what exists, and a typo becomes a
 * compile error instead of an event that is silently never queried.
 *
 * Severity: 0 info, 1 low, 2 medium, 3 high, 4 critical.
 * Anything at 3 or above pages an operator (security/alerts.ts), so raising a
 * severity has an on-call cost and should be deliberate.
 */
export const securityEventSeverity = {
  // --- authentication -----------------------------------------------------
  'auth.login_succeeded': 0,
  'auth.login_failed': 1,
  // A correct-looking attempt that was refused because the account is in a
  // cooldown window. Distinct from login_failed so that the dashboard can
  // separate "attacker is still trying" from "user mistyped once".
  'auth.login_blocked': 2,
  // Correct credentials against a suspended or deleted account: either an
  // operator error or an attacker working from a stale credential dump.
  'auth.login_denied_status': 2,
  'auth.account_locked': 3,
  'auth.account_lock_escalated': 3,
  'auth.unverified_login_attempt': 1,

  // --- credential hygiene -------------------------------------------------
  'auth.password_policy_rejected': 0,
  'auth.password_breached_rejected': 1,
  // The breach oracle failed open (see auth/pwned-passwords.ts). Medium, not
  // low: a sustained outage silently removes a control.
  'auth.breach_check_unavailable': 2,
  'auth.password_changed': 2,

  // --- password reset (the flow introduced in migration 008) ---------------
  'auth.reset_requested': 1,
  // A request suppressed by the per-account cooldown. Low on its own; the W7
  // rules care about the rate, which is what distinguishes a user clicking
  // twice from an inbox being flooded.
  'auth.reset_throttled': 1,
  'auth.reset_completed': 2,
  // Presenting a token that is expired, already used, or fabricated.
  'auth.reset_token_rejected': 2,
  // The link was delivered to an address whose control was never proven.
  'auth.reset_unverified_account': 2,

  // --- sessions -----------------------------------------------------------
  // Replay of a rotated refresh token: this is either token theft or a broken
  // client, and it already triggers a full session revocation in auth.ts.
  'session.refresh_reused': 4,
  'session.revoked_all': 2,

  // --- access control -----------------------------------------------------
  'access.forbidden': 2,
  'access.origin_rejected': 1,
  'access.rate_limited': 1,
} as const;

export type SecurityEventType = keyof typeof securityEventSeverity;
export type SecuritySeverity = 0 | 1 | 2 | 3 | 4;
export type SecurityDecision = 'allow' | 'challenge' | 'deny' | 'lock';

export const defaultSeverity = (type: SecurityEventType): SecuritySeverity =>
  securityEventSeverity[type] as SecuritySeverity;

/**
 * ASVS 7.3.3.  Any key whose name matches one of these is dropped before the
 * context reaches the database.  The match is on the key, not the value,
 * because a denylist of values cannot be written correctly.
 *
 * This is a backstop, not the primary control: call sites are expected not to
 * pass secrets in the first place. It exists because the alternative -- a
 * reviewer having to verify every future call site by hand -- does not scale.
 */
const forbiddenKeyPattern = /pass|secret|token|credential|cookie|authorization|session|pepper|signature|apikey|api_key/i;

/**
 * Bare `email` and `ip` are also dropped: the ledger stores fingerprints of
 * those, and a call site that passes the raw value is a bug, not a preference.
 */
const rawIdentifierKeys = new Set(['email', 'emailaddress', 'ip', 'ipaddress', 'useragent', 'ua']);

const maxStringLength = 200;
const maxKeys = 24;
const maxSerialisedBytes = 4096;

function sanitiseValue(value: unknown, depth: number): unknown {
  if (value === null) return null;
  if (typeof value === 'string') return value.length > maxStringLength ? `${value.slice(0, maxStringLength)}…` : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  // Depth is capped rather than recursed freely: an unbounded object graph
  // from a handler would make the row size unpredictable.
  if (depth >= 2) return null;
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => sanitiseValue(item, depth + 1));
  if (typeof value === 'object') return sanitiseContext(value as Record<string, unknown>, depth + 1);
  return null;
}

export function sanitiseContext(context: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(context)) {
    if (kept >= maxKeys) break;
    if (forbiddenKeyPattern.test(key)) continue;
    if (rawIdentifierKeys.has(key.toLowerCase().replace(/[^a-z]/g, ''))) continue;
    const sanitised = sanitiseValue(value, depth);
    if (sanitised === null && value !== null) continue;
    output[key] = sanitised;
    kept += 1;
  }
  if (depth === 0 && Buffer.byteLength(JSON.stringify(output)) > maxSerialisedBytes) {
    return { truncated: true, keys: Object.keys(output).slice(0, maxKeys) };
  }
  return output;
}
