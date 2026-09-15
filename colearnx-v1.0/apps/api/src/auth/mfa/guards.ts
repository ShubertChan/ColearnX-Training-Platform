import type { NextFunction, Request, Response } from 'express';
import { env } from '../../config/env.js';
import { ApiError } from '../../lib/http.js';
import { recordSecurityEvent, securityContext } from '../../security/events.js';
import type { Actor } from '../auth.js';
import { verifyChallenge } from './challenge.js';
import { readMfaState } from './service.js';

/**
 * Administrative access requires an enrolled second factor (ASVS 4.3.1).
 *
 * An administrator session is the most valuable credential on the platform:
 * it reaches every user's data and every paid asset. Protecting it with a
 * password alone means one phishing page or one reused credential is a total
 * compromise.
 *
 * Read endpoints are gated too, not only writes. An attacker who can enumerate
 * every user and download every private course asset has already done most of
 * the damage, whether or not they changed anything.
 *
 * The response names the remedy rather than returning a bare 403, because the
 * person receiving it is a legitimate administrator who needs to know what to
 * do. This discloses nothing: they have already proven they hold an admin
 * session.
 */
export async function requireAdminMfa(_req: Request, res: Response, next: NextFunction) {
  try {
    const actor = res.locals.actor as Actor | undefined;
    if (!actor) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication is required.');
    const state = await readMfaState(actor.id);
    if (!state.enrolled) {
      throw new ApiError(
        403, 'MFA_ENROLMENT_REQUIRED',
        'Administrative access requires two-factor authentication. Enable it in your security settings.',
      );
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * Re-authentication immediately before a high-risk action (ASVS 3.7.1).
 *
 * Threat model F-10: a stolen or borrowed administrator session could
 * otherwise bulk-export paid content or change roles silently. Step-up narrows
 * the window from "the whole session" to "the minutes after a fresh factor
 * was presented", and it requires the physical authenticator, so a session
 * token alone is no longer sufficient.
 *
 * The token travels in a header rather than a cookie: it must be attached
 * deliberately by the code performing the action, never sent automatically by
 * the browser with any request that happens to go out.
 */
export async function requireStepUp(_req: Request, res: Response, next: NextFunction) {
  try {
    const actor = res.locals.actor as Actor | undefined;
    if (!actor) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication is required.');

    const token = _req.get('x-step-up-token');
    if (!token) {
      throw new ApiError(401, 'STEP_UP_REQUIRED', 'Confirm your identity to continue.');
    }
    const result = verifyChallenge(token, 'step-up', env.MFA_CHALLENGE_SECRET);
    // Binding to the acting account matters as much as the signature: a valid
    // step-up token issued to one administrator must not authorise an action
    // performed under another's session.
    if (!result.valid || result.subject !== actor.id) {
      await recordSecurityEvent(securityContext(_req, res), {
        type: 'auth.step_up_rejected', actorUserId: actor.id, decision: 'deny',
        context: { reason: result.valid ? 'subject-mismatch' : result.reason },
      }, res);
      throw new ApiError(401, 'STEP_UP_REQUIRED', 'Confirm your identity to continue.');
    }
    return next();
  } catch (error) {
    return next(error);
  }
}
