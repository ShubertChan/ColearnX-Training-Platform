/**
 * The lockout ladder, kept free of any database or environment import so that
 * it can be tested exhaustively in isolation -- the same split this codebase
 * already uses for refunds/policy.ts against refunds/service.ts.
 *
 * Gentle at the start, steep later: users mistype, attackers persist. Five
 * fat-fingered attempts cost a minute, which a real user barely notices; twenty
 * cost six hours, which destroys the throughput a credential-stuffing run
 * depends on.
 */
export type LadderStep = { atFailures: number; lockSeconds: number };

export const lockoutLadder: readonly LadderStep[] = [
  { atFailures: 5, lockSeconds: 60 },
  { atFailures: 7, lockSeconds: 5 * 60 },
  { atFailures: 10, lockSeconds: 15 * 60 },
  { atFailures: 15, lockSeconds: 60 * 60 },
  { atFailures: 20, lockSeconds: 6 * 60 * 60 },
];

/** Severity 3 alerting starts here: this many failures is no longer a typo. */
export const lockoutAlertThreshold = 10;

/** The lock length for a consecutive-failure count; 0 means no lock. */
export function lockDurationSeconds(consecutiveFailures: number): number {
  let seconds = 0;
  for (const step of lockoutLadder) {
    if (consecutiveFailures >= step.atFailures) seconds = step.lockSeconds;
  }
  return seconds;
}

/**
 * Renders a lock duration for the notification email.
 *
 * Kept here, next to the ladder it describes, so the wording can never drift
 * from the numbers. Rounded rather than exact: the email says "about 15
 * minutes", not a timestamp, because by the time it is read the remaining time
 * has already changed and a stale countdown is worse than none.
 */
export function describeLockDuration(seconds: number): string {
  if (seconds <= 0) return 'a short time';
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  const hours = Math.round(seconds / 3600);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}
