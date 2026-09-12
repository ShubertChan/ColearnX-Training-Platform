import { query, withTransaction } from '../db/database.js';
import { lockDurationSeconds } from './lockout-policy.js';

/**
 * Progressive per-account lockout (threat model F-02, ASVS 2.2.1).
 *
 * The existing IP-based limiter in app.ts caps 20 attempts per 15 minutes per
 * source address.  That stops one machine hammering one account; it does not
 * stop credential stuffing, where an attacker holding a breach dump tries each
 * stolen pair exactly once from a different proxy.  Every request in such a
 * run is under the IP limit, so the limiter never fires.  Counting failures
 * per account is the control that does fire.
 *
 * THE LADDER is intentionally gentle at the start and steep later.  Users
 * mistype; attackers persist.  Five fat-fingered attempts cost a minute, which
 * a real user barely notices, while twenty cost six hours, which destroys the
 * throughput any stuffing run depends on.
 *
 * DENIAL-OF-SERVICE COUNTERWEIGHT (threat model section 5.1): every lock
 * expires on its own, a locked account is indistinguishable from a wrong
 * password in the HTTP response, and completing a password reset clears the
 * lock.  A griefer can delay a victim; they cannot lock them out permanently
 * and cannot learn whether the address exists.
 */

export { lockDurationSeconds, lockoutAlertThreshold, lockoutLadder } from './lockout-policy.js';
export type LockState = {
  locked: boolean;
  lockedUntil: Date | null;
  consecutiveFailures: number;
};

const emptyState: LockState = { locked: false, lockedUntil: null, consecutiveFailures: 0 };

export async function readLockState(userId: string): Promise<LockState> {
  const result = await query<{ locked_until: Date | null; consecutive_failures: number }>(
    'SELECT locked_until, consecutive_failures FROM auth_failure_counters WHERE user_id = $1',
    [userId],
  );
  const row = result.rows[0];
  if (!row) return emptyState;
  return {
    locked: Boolean(row.locked_until && row.locked_until > new Date()),
    lockedUntil: row.locked_until,
    consecutiveFailures: row.consecutive_failures,
  };
}

export type FailureOutcome = {
  consecutiveFailures: number;
  lockedUntil: Date | null;
  /** True only on the transition into a lock, so the event is recorded once. */
  newlyLocked: boolean;
};

/**
 * Records one failed attempt and applies the ladder.
 *
 * Runs inside a transaction with `FOR UPDATE` rather than as a bare atomic
 * increment: the counter is read, decayed, incremented and then converted to a
 * lock, and two concurrent attempts that interleave those steps would
 * otherwise each see the pre-increment value and neither would cross the
 * threshold.  Parallel guessing is exactly the case this must survive.
 *
 * The decay window means failures must be *consecutive in time* as well as in
 * sequence: three typos last week plus two today should not equal five.
 */
export async function registerFailure(userId: string, decaySeconds: number): Promise<FailureOutcome> {
  return withTransaction(async (client) => {
    const existing = await client.query<{
      consecutive_failures: number;
      last_failure_at: Date;
      locked_until: Date | null;
    }>(
      `SELECT consecutive_failures, last_failure_at, locked_until
         FROM auth_failure_counters WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );

    const now = new Date();
    const row = existing.rows[0];
    const decayed = row ? row.last_failure_at.getTime() < now.getTime() - decaySeconds * 1000 : true;
    const consecutiveFailures = !row || decayed ? 1 : row.consecutive_failures + 1;

    const seconds = lockDurationSeconds(consecutiveFailures);
    const wasLocked = Boolean(row?.locked_until && row.locked_until > now);
    const lockedUntil = seconds > 0 ? new Date(now.getTime() + seconds * 1000) : row?.locked_until ?? null;

    await client.query(
      `INSERT INTO auth_failure_counters
         (user_id, consecutive_failures, window_started_at, last_failure_at, locked_until, lockout_count)
       VALUES ($1, $2, now(), now(), $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         consecutive_failures = $2,
         window_started_at = CASE WHEN $5 THEN now() ELSE auth_failure_counters.window_started_at END,
         last_failure_at = now(),
         locked_until = $3,
         lockout_count = auth_failure_counters.lockout_count + $4,
         updated_at = now()`,
      [userId, consecutiveFailures, lockedUntil, seconds > 0 && !wasLocked ? 1 : 0, decayed],
    );

    return { consecutiveFailures, lockedUntil, newlyLocked: seconds > 0 && !wasLocked };
  });
}

/**
 * Clears the counters after a successful authentication or a completed reset.
 *
 * `lockout_count` is deliberately not reset: an account that has been locked
 * six times over its life is a different risk profile from one that never has,
 * and the W7 scorer needs that history.  The row is kept for the same reason.
 */
export async function clearFailures(userId: string): Promise<void> {
  await query(
    `UPDATE auth_failure_counters
        SET consecutive_failures = 0, locked_until = NULL, window_started_at = now(), updated_at = now()
      WHERE user_id = $1 AND (consecutive_failures > 0 OR locked_until IS NOT NULL)`,
    [userId],
  );
}
