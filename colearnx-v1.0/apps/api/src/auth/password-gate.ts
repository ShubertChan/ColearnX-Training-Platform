import type { Response } from 'express';
import { env } from '../config/env.js';
import { ApiError } from '../lib/http.js';
import { recordSecurityEvent, type RequestFingerprint } from '../security/events.js';
import { evaluatePassword, type PasswordContext } from './password-policy.js';
import { breachCount } from './pwned-passwords.js';

/**
 * The single place a new password is admitted.
 *
 * Registration and reset both route through here so that the two surfaces
 * cannot drift apart -- a policy enforced on sign-up but not on reset is a
 * policy an attacker simply resets around, and that drift is the normal way
 * this control decays in practice.
 */
export async function assertPasswordAcceptable(
  password: string,
  context: PasswordContext,
  surface: 'registration' | 'reset',
  fingerprint: RequestFingerprint,
  res: Response,
  actorUserId: string | null = null,
): Promise<void> {
  const rejection = evaluatePassword(password, context, env.PASSWORD_MIN_LENGTH);
  if (rejection) {
    await recordSecurityEvent(fingerprint, {
      type: 'auth.password_policy_rejected',
      actorUserId,
      context: { reason: rejection.code, surface },
    }, res);
    throw new ApiError(400, rejection.code, rejection.message);
  }

  const breach = await breachCount(password);
  if (breach.status === 'checked' && breach.count > 0) {
    await recordSecurityEvent(fingerprint, {
      type: 'auth.password_breached_rejected',
      actorUserId,
      // The occurrence count is not echoed to the user: "seen 4.2 million
      // times" is a nudge to try the second-most-common password rather than
      // a genuinely new one.
      context: { surface },
    }, res);
    throw new ApiError(
      400,
      'PASSWORD_BREACHED',
      'This password has appeared in a public data breach. Choose a different one.',
    );
  }

  if (breach.status === 'unavailable' && breach.reason !== 'disabled') {
    // Fail open, but never silently: see the rationale in pwned-passwords.ts.
    await recordSecurityEvent(fingerprint, {
      type: 'auth.breach_check_unavailable',
      actorUserId,
      context: { reason: breach.reason, surface },
    }, res);
  }
}
