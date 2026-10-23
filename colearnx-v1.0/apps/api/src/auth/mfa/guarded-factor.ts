// Second-factor checks for an already signed-in account (step-up, disabling
// two-factor, rotating recovery codes) go through the SAME per-account
// lockout ladder as the sign-in MFA step.
//
// Before this, those three routes called verifySecondFactor directly. Their
// only brake was the per-IP authLimiter, so an attacker holding a stolen
// session and rotating source addresses could guess 6-digit codes without
// ever engaging the account lock -- and a hit on /auth/mfa/disable removes the
// second factor outright, while a hit on /auth/step-up unlocks the admin
// actions step-up exists to protect. Stolen sessions are precisely the threat
// these routes are meant to stop.
//
// Same rules as verifyMfaLogin in auth.ts: a locked account is refused BEFORE
// the code is checked (so a correct code cannot be confirmed by trial and a
// locked attempt never consumes a TOTP step or recovery code), every wrong
// code counts toward the ladder, and a correct code clears the counter.

import { clearFailures, readLockState, registerFailure, type FailureOutcome, type LockState } from '../lockout.js';
import { verifySecondFactor, type FactorResult } from './service.js';

export type GuardedFactorResult =
  | Extract<FactorResult, { ok: true }>
  | { ok: false; reason: 'locked'; lockedUntil: Date | null }
  | { ok: false; reason: 'not-enrolled' | 'invalid'; failure: FailureOutcome };

export type GuardedFactorDependencies = {
  readLockState: (userId: string) => Promise<LockState>;
  verifySecondFactor: (userId: string, code: string) => Promise<FactorResult>;
  registerFailure: (userId: string, decaySeconds: number) => Promise<FailureOutcome>;
  clearFailures: (userId: string) => Promise<void>;
};

const defaults: GuardedFactorDependencies = { readLockState, verifySecondFactor, registerFailure, clearFailures };

export async function verifyFactorWithLockout(
  userId: string,
  code: string,
  decaySeconds: number,
  dependencies: GuardedFactorDependencies = defaults,
): Promise<GuardedFactorResult> {
  const lock = await dependencies.readLockState(userId);
  if (lock.locked) return { ok: false, reason: 'locked', lockedUntil: lock.lockedUntil };
  const factor = await dependencies.verifySecondFactor(userId, code);
  if (!factor.ok) {
    const failure = await dependencies.registerFailure(userId, decaySeconds);
    return { ok: false, reason: factor.reason, failure };
  }
  await dependencies.clearFailures(userId);
  return factor;
}
