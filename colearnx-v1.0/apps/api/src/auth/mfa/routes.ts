import type { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ApiError, ok } from '../../lib/http.js';
import { parse } from '../../lib/validation.js';
import { recordSecurityEvent, securityContext } from '../../security/events.js';
import type { Actor } from '../auth.js';
import { issueChallenge } from './challenge.js';
import { formatRecoveryCode } from './recovery-codes.js';
import {
  beginEnrolment, confirmEnrolment, disableMfa, readMfaState,
  regenerateRecoveryCodes, verifySecondFactor,
} from './service.js';

const codeSchema = z.object({ code: z.string().trim().min(6).max(32) });

export async function getMfaStatus(_req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const state = await readMfaState(actor.id);
  return ok(res, {
    enrolled: state.enrolled,
    pending: state.pending,
    confirmedAt: state.confirmedAt,
    recoveryCodesRemaining: state.recoveryCodesRemaining,
  });
}

export async function startMfaEnrolment(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const result = await beginEnrolment(actor.id, actor.email);
  if (result.alreadyEnrolled) {
    // Replacing a live factor without proving possession of the current one
    // would let anyone holding a session swap it for their own, which is worse
    // than having no second factor at all.
    throw new ApiError(409, 'MFA_ALREADY_ENROLLED', 'Two-factor authentication is already enabled. Disable it first to re-enrol.');
  }
  await recordSecurityEvent(securityContext(req, res), {
    type: 'auth.mfa_enrolment_started', actorUserId: actor.id,
  }, res);
  // The secret is returned exactly once, in the response to the request that
  // created it. It is never readable again: after confirmation the only copy
  // outside the authenticator app is the encrypted one in the database.
  return ok(res, { secret: result.secret, otpauthUri: result.otpauthUri });
}

export async function confirmMfaEnrolment(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(codeSchema, req.body);
  const result = await confirmEnrolment(actor.id, input.code);

  if (result.status === 'no-pending') {
    throw new ApiError(409, 'MFA_NOT_PENDING', 'Start enrolment before confirming it.');
  }
  if (result.status === 'invalid-code') {
    await recordSecurityEvent(securityContext(req, res), {
      type: 'auth.mfa_enrolment_failed', actorUserId: actor.id, decision: 'deny',
    }, res);
    throw new ApiError(400, 'MFA_CODE_INVALID', 'That code is not valid. Check your authenticator app and try again.');
  }

  await recordSecurityEvent(securityContext(req, res), {
    type: 'auth.mfa_enabled', actorUserId: actor.id,
  }, res);
  // Recovery codes are shown once and never again. Storing a retrievable copy
  // would make them a second standing credential that a session compromise
  // could read, defeating their purpose as an out-of-band escape hatch.
  return ok(res, { enabled: true, recoveryCodes: result.recoveryCodes.map(formatRecoveryCode) });
}

export async function disableMfaForSelf(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(codeSchema, req.body);
  const state = await readMfaState(actor.id);
  if (!state.enrolled) throw new ApiError(409, 'MFA_NOT_ENABLED', 'Two-factor authentication is not enabled.');

  // Disabling is itself a high-risk action: it is the step an attacker holding
  // a session would take first. Requiring a current factor means a stolen
  // session alone cannot remove the protection.
  const factor = await verifySecondFactor(actor.id, input.code);
  if (!factor.ok) {
    await recordSecurityEvent(securityContext(req, res), {
      type: 'auth.mfa_disable_rejected', actorUserId: actor.id, decision: 'deny',
    }, res);
    throw new ApiError(400, 'MFA_CODE_INVALID', 'That code is not valid.');
  }

  await disableMfa(actor.id);
  await recordSecurityEvent(securityContext(req, res), {
    type: 'auth.mfa_disabled', actorUserId: actor.id,
    context: { viaRecoveryCode: factor.usedRecoveryCode },
  }, res);
  return ok(res, { enabled: false });
}

export async function rotateRecoveryCodes(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(codeSchema, req.body);
  const state = await readMfaState(actor.id);
  if (!state.enrolled) throw new ApiError(409, 'MFA_NOT_ENABLED', 'Two-factor authentication is not enabled.');

  const factor = await verifySecondFactor(actor.id, input.code);
  if (!factor.ok) throw new ApiError(400, 'MFA_CODE_INVALID', 'That code is not valid.');

  const codes = await regenerateRecoveryCodes(actor.id);
  await recordSecurityEvent(securityContext(req, res), {
    type: 'auth.recovery_codes_rotated', actorUserId: actor.id,
  }, res);
  return ok(res, { recoveryCodes: codes.map(formatRecoveryCode) });
}

/**
 * Exchanges a current second factor for a short-lived step-up token.
 *
 * Deliberately separate from the sign-in flow: this proves possession *now*,
 * minutes before the sensitive action, rather than at some point earlier in a
 * session that may since have been stolen.
 */
export async function requestStepUp(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(codeSchema, req.body);
  const state = await readMfaState(actor.id);
  if (!state.enrolled) {
    throw new ApiError(409, 'MFA_NOT_ENABLED', 'Enable two-factor authentication before performing this action.');
  }

  const factor = await verifySecondFactor(actor.id, input.code);
  if (!factor.ok) {
    await recordSecurityEvent(securityContext(req, res), {
      type: 'auth.step_up_rejected', actorUserId: actor.id, decision: 'deny',
      context: { reason: 'invalid-factor' },
    }, res);
    throw new ApiError(400, 'MFA_CODE_INVALID', 'That code is not valid.');
  }

  const token = issueChallenge('step-up', actor.id, env.STEP_UP_TTL_SECONDS, env.MFA_CHALLENGE_SECRET);
  await recordSecurityEvent(securityContext(req, res), {
    type: 'auth.step_up_granted', actorUserId: actor.id,
    context: { ttlSeconds: env.STEP_UP_TTL_SECONDS, viaRecoveryCode: factor.usedRecoveryCode },
  }, res);
  return ok(res, { stepUpToken: token, expiresInSeconds: env.STEP_UP_TTL_SECONDS });
}
