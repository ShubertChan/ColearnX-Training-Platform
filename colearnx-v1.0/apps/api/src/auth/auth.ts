import argon2 from 'argon2';
import { createHmac, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { env } from '../config/env.js';
import { query, withTransaction } from '../db/database.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../email/resend.js';
import { createOpaqueToken, sha256 } from '../lib/crypto.js';
import { ApiError, ok } from '../lib/http.js';
import { parse } from '../lib/validation.js';
import { sendPasswordChangedEmail } from '../email/resend.js';
import { recordSecurityEvent, securityContext } from '../security/events.js';
import { emailFingerprint } from '../security/fingerprint.js';
import { passwordResetUrl } from './password-reset-url.js';
import { verifyPasswordConstantWork } from './credential-verify.js';
import { clearFailures, lockoutAlertThreshold, readLockState, registerFailure } from './lockout.js';
import { assertPasswordAcceptable } from './password-gate.js';
import {
  createVerificationCode,
  hashVerificationCode,
  verificationCodeLength,
  verificationCodeMatches,
  verificationWindow,
} from './email-verification.js';
import {
  registrationContinuationLifetimeSeconds,
  signRegistrationContinuation,
  verifyRegistrationContinuation,
} from './registration-continuation.js';

export type Actor = {
  id: string;
  email: string;
  roles: string[];
  status: string;
  emailVerifiedAt: Date | null;
  emailVerificationRequiredAt: Date | null;
};

type VerificationUser = {
  id: string;
  email: string;
  status: string;
  email_verified_at: Date | null;
  email_verification_required_at: Date | null;
};

type PendingChallenge = {
  userId: string;
  email: string;
  code: string;
  expiresAt: Date;
  resendAvailableAt: Date;
};

type RegistrationOutcome =
  | { kind: 'send'; challenge: PendingChallenge }
  | { kind: 'reuse'; userId: string; email: string; expiresAt: Date; resendAvailableAt: Date }
  | { kind: 'conflict' };

const emailSchema = z.string().trim().email().max(320);
// Sign-in deliberately does NOT apply the registration policy. Accounts
// created before migration 010 are grandfathered on shorter passwords, and a
// 400 for a short submission would both lock those users out and disclose what
// the policy is. Anything that is not the stored password gets the same 401.
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(1024) });
// Strength is enforced by assertPasswordAcceptable rather than by the schema,
// so that registration and reset share one implementation and cannot drift.
const credentialsSchema = z.object({ email: emailSchema, password: z.string().min(1).max(1024) });
const registrationSchema = credentialsSchema.extend({
  displayName: z.string().trim().min(1).max(120),
  passwordConfirmation: z.string().min(1).max(1024),
  acceptedTerms: z.literal(true),
  ageAcknowledged: z.literal(true),
}).refine((input) => input.password === input.passwordConfirmation, {
  message: 'Passwords do not match.', path: ['passwordConfirmation'],
});
const verificationSchema = z.object({
  email: emailSchema,
  code: z.string().trim().regex(new RegExp(`^\\d{${verificationCodeLength}}$`), 'Enter the complete verification code.'),
});
const resendVerificationSchema = z.object({ email: emailSchema });
const accessTokenLifetime = '15m';
const forgotPasswordSchema = z.object({ email: emailSchema }).strict();
const resetPasswordSchema = z.object({
  token: z.string().trim().regex(/^[A-Za-z0-9_-]{32,200}$/),
  password: z.string().min(1).max(1024),
  passwordConfirmation: z.string().min(1).max(1024),
}).strict().refine((input) => input.password === input.passwordConfirmation, {
  message: 'Passwords do not match.', path: ['passwordConfirmation'],
});
const refreshLifetimeMs = 1000 * 60 * 60 * 24 * 14;
const refreshCookieName = 'colearnx_refresh';
const registrationContinuationCookieName = 'colearnx_registration';

function signAccessToken(actor: Actor) {
  return jwt.sign({ sub: actor.id, email: actor.email, roles: actor.roles }, env.ACCESS_TOKEN_SECRET, { expiresIn: accessTokenLifetime });
}

async function loadActor(userId: string): Promise<Actor | null> {
  const result = await query<Actor>(`SELECT u.user_id AS id, u.email::text AS email, u.account_status AS status,
    u.email_verified_at AS "emailVerifiedAt", u.email_verification_required_at AS "emailVerificationRequiredAt",
    COALESCE(array_agg(r.role_code) FILTER (WHERE ur.revoked_at IS NULL), '{}') AS roles
    FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.user_id AND ur.revoked_at IS NULL
    LEFT JOIN roles r ON r.role_id = ur.role_id WHERE u.user_id = $1 GROUP BY u.user_id`, [userId]);
  return result.rows[0] ?? null;
}

function actorNeedsEmailVerification(actor: Actor) {
  return Boolean(actor.emailVerificationRequiredAt && !actor.emailVerifiedAt);
}

function authCookieBaseOptions() {
  const secure = env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' as const : 'lax' as const,
    domain: env.COOKIE_DOMAIN || undefined,
    path: '/api/v1/auth',
  };
}

function refreshCookieOptions() {
  return { ...authCookieBaseOptions(), maxAge: refreshLifetimeMs };
}

function registrationContinuationCookieOptions() {
  return {
    ...authCookieBaseOptions(),
    maxAge: registrationContinuationLifetimeSeconds * 1000,
  };
}

function createCsrfToken(refreshToken: string) {
  return createHmac('sha256', env.CSRF_SECRET).update(refreshToken).digest('base64url');
}

function assertCsrfToken(req: Request, refreshToken: string) {
  const supplied = req.get('x-csrf-token');
  const expected = createCsrfToken(refreshToken);
  if (!supplied) throw new ApiError(403, 'CSRF_TOKEN_MISSING', 'A CSRF token is required.');
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    throw new ApiError(403, 'CSRF_TOKEN_INVALID', 'The CSRF token is invalid.');
  }
}

async function createRefreshSession(actor: Actor, req: Request, res: Response) {
  const token = createOpaqueToken();
  await query(`INSERT INTO refresh_sessions (user_id, token_hash, expires_at, user_agent, ip_hash) VALUES ($1, $2, $3, $4, $5)`, [actor.id, sha256(token), new Date(Date.now() + refreshLifetimeMs), req.get('user-agent')?.slice(0, 500) ?? null, sha256(req.ip || 'unknown')]);
  res.cookie(refreshCookieName, token, refreshCookieOptions());
  return token;
}

function createChallenge(userId: string, email: string): PendingChallenge {
  const code = createVerificationCode();
  const { expiresAt, resendAvailableAt } = verificationWindow(
    new Date(),
    env.EMAIL_VERIFICATION_CODE_TTL_MINUTES,
    env.EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS,
  );
  return { userId, email, code, expiresAt, resendAvailableAt };
}

async function sendPendingChallenge(challenge: PendingChallenge) {
  try {
    await sendVerificationEmail({
      to: challenge.email,
      code: challenge.code,
      expiresInMinutes: env.EMAIL_VERIFICATION_CODE_TTL_MINUTES,
    });
  } catch {
    // Do not strand an account when the provider is temporarily unavailable:
    // a retry can immediately use the resend endpoint.
    await query(`UPDATE email_verification_challenges
      SET resend_available_at = now(), updated_at = now()
      WHERE user_id = $1`, [challenge.userId]);
    throw new ApiError(503, 'EMAIL_DELIVERY_UNAVAILABLE', 'We could not send the verification email. Please try again.');
  }
}

function canContinueRegistration(user: VerificationUser | undefined): user is VerificationUser {
  return Boolean(user && user.status === 'active' && user.email_verification_required_at && !user.email_verified_at);
}

export async function resumePendingRegistration(client: PoolClient, email: string, password: string): Promise<RegistrationOutcome> {
  const users = await client.query<VerificationUser & { password_hash: string }>(`SELECT user_id AS id, email::text AS email, account_status AS status,
    email_verified_at, email_verification_required_at, password_hash
    FROM users WHERE lower(email::text) = lower($1) FOR UPDATE`, [email]);
  const user = users.rows[0];
  if (!canContinueRegistration(user)) return { kind: 'conflict' };
  // A retry resumes the original registration, not a new password assignment.
  // Check its credentials before issuing a continuation or changing a challenge.
  if (!await argon2.verify(user.password_hash, password)) return { kind: 'conflict' };

  const current = await client.query<{ expires_at: Date; resend_available_at: Date; failed_attempts: number }>(
    'SELECT expires_at, resend_available_at, failed_attempts FROM email_verification_challenges WHERE user_id = $1 FOR UPDATE',
    [user.id],
  );
  const challenge = current.rows[0];
  if (challenge && challenge.expires_at > new Date() && challenge.failed_attempts < env.EMAIL_VERIFICATION_MAX_ATTEMPTS) {
    return {
      kind: 'reuse',
      userId: user.id,
      email: user.email,
      expiresAt: challenge.expires_at,
      resendAvailableAt: challenge.resend_available_at,
    };
  }

  const replacement = createChallenge(user.id, user.email);
  await client.query(`INSERT INTO email_verification_challenges
    (user_id, code_hash, expires_at, resend_available_at, failed_attempts)
    VALUES ($1, $2, $3, $4, 0)
    ON CONFLICT (user_id) DO UPDATE SET
      code_hash = EXCLUDED.code_hash,
      expires_at = EXCLUDED.expires_at,
      resend_available_at = EXCLUDED.resend_available_at,
      failed_attempts = 0,
      updated_at = now()`,
  [user.id, hashVerificationCode(replacement.code, env.EMAIL_VERIFICATION_CODE_PEPPER), replacement.expiresAt, replacement.resendAvailableAt]);
  return { kind: 'send', challenge: replacement };
}

function isUniqueEmailViolation(error: unknown) {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

const originIsAllowed = (req: Request) => !req.get('origin') || req.get('origin') === env.APP_ORIGIN;

export async function register(req: Request, res: Response) {
  const input = parse(registrationSchema, req.body);
  const fingerprint = securityContext(req, res);
  // Before the account is touched: a rejected password must not leave a
  // half-created user or consume the address.
  await assertPasswordAcceptable(input.password, { email: input.email, displayName: input.displayName }, 'registration', fingerprint, res);
  let outcome: RegistrationOutcome;
  try {
    outcome = await withTransaction(async (client) => {
      const existing = await client.query<VerificationUser>(`SELECT user_id AS id, email::text AS email, account_status AS status,
        email_verified_at, email_verification_required_at
        FROM users WHERE lower(email::text) = lower($1) FOR UPDATE`, [input.email]);
      if (existing.rowCount) return resumePendingRegistration(client, input.email, input.password);
      const user = await client.query<VerificationUser>(`INSERT INTO users
      (full_name, email, password_hash, email_verification_required_at)
      VALUES ($1, $2, $3, now())
      RETURNING user_id AS id, email::text AS email, account_status AS status,
        email_verified_at, email_verification_required_at`,
      [input.displayName, input.email, await argon2.hash(input.password, { type: argon2.argon2id })]);
      const userId = user.rows[0].id;
      const challenge = createChallenge(userId, user.rows[0].email);
      await client.query(`INSERT INTO email_verification_challenges
      (user_id, code_hash, expires_at, resend_available_at)
      VALUES ($1, $2, $3, $4)`,
      [userId, hashVerificationCode(challenge.code, env.EMAIL_VERIFICATION_CODE_PEPPER), challenge.expiresAt, challenge.resendAvailableAt]);
      await client.query(`INSERT INTO profiles (user_id, display_name) VALUES ($1, $2)`, [userId, input.displayName]);
      await client.query('INSERT INTO point_accounts (user_id) VALUES ($1)', [userId]);
      await client.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, role_id FROM roles WHERE role_code = 'member'`, [userId]);
      await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json)
      VALUES ($1, 'auth.register', 'users', $2, jsonb_build_object('roles', $3::jsonb, 'emailVerificationRequired', true))`,
      [userId, userId, JSON.stringify(['member'])]);
      return { kind: 'send' as const, challenge };
    });
  } catch (error) {
    if (!isUniqueEmailViolation(error)) throw error;
    outcome = await withTransaction((client) => resumePendingRegistration(client, input.email, input.password));
  }
  if (outcome.kind === 'conflict') throw new ApiError(409, 'EMAIL_ALREADY_REGISTERED', 'Unable to create this account.');
  const registration = outcome.kind === 'send'
    ? {
        userId: outcome.challenge.userId,
        email: outcome.challenge.email,
        expiresAt: outcome.challenge.expiresAt,
        resendAvailableAt: outcome.challenge.resendAvailableAt,
      }
    : outcome;

  res.cookie(
    registrationContinuationCookieName,
    signRegistrationContinuation({
      userId: registration.userId,
      email: registration.email,
    }, env.REFRESH_TOKEN_SECRET),
    registrationContinuationCookieOptions(),
  );
  if (outcome.kind === 'send') await sendPendingChallenge(outcome.challenge);
  return ok(res, {
    email: registration.email,
    verificationRequired: true,
    expiresAt: registration.expiresAt.toISOString(),
    resendAvailableAt: registration.resendAvailableAt.toISOString(),
  }, 202);
}

export async function verifyEmail(req: Request, res: Response) {
  const input = parse(verificationSchema, req.body);
  const continuation = verifyRegistrationContinuation(
    req.cookies?.[registrationContinuationCookieName] as string | undefined,
    env.REFRESH_TOKEN_SECRET,
  );
  const outcome = await withTransaction(async (client) => {
    const users = await client.query<VerificationUser>(`SELECT user_id AS id, email::text AS email, account_status AS status,
      email_verified_at, email_verification_required_at
      FROM users WHERE lower(email::text) = lower($1) FOR UPDATE`, [input.email]);
    const user = users.rows[0];
    if (!user || user.status !== 'active' || !user.email_verification_required_at || user.email_verified_at) {
      return { kind: 'invalid' as const };
    }
    const challenges = await client.query<{ code_hash: string; expires_at: Date; failed_attempts: number }>(
      'SELECT code_hash, expires_at, failed_attempts FROM email_verification_challenges WHERE user_id = $1 FOR UPDATE',
      [user.id],
    );
    const challenge = challenges.rows[0];
    if (!challenge) return { kind: 'invalid' as const };
    if (challenge.expires_at <= new Date()) return { kind: 'expired' as const };
    if (challenge.failed_attempts >= env.EMAIL_VERIFICATION_MAX_ATTEMPTS) return { kind: 'locked' as const };
    if (!verificationCodeMatches(input.code, challenge.code_hash, env.EMAIL_VERIFICATION_CODE_PEPPER)) {
      const attempts = await client.query<{ failed_attempts: number }>(`UPDATE email_verification_challenges
        SET failed_attempts = failed_attempts + 1, updated_at = now()
        WHERE user_id = $1 RETURNING failed_attempts`, [user.id]);
      return { kind: attempts.rows[0].failed_attempts >= env.EMAIL_VERIFICATION_MAX_ATTEMPTS ? 'locked' as const : 'invalid' as const };
    }
    await client.query('UPDATE users SET email_verified_at = now(), updated_at = now() WHERE user_id = $1', [user.id]);
    await client.query('DELETE FROM email_verification_challenges WHERE user_id = $1', [user.id]);
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json)
      VALUES ($1, 'auth.email_verified', 'users', $2, jsonb_build_object('method', 'email_code'))`, [user.id, user.id]);
    return { kind: 'verified' as const, userId: user.id, email: user.email };
  });

  if (outcome.kind === 'expired') throw new ApiError(400, 'EMAIL_VERIFICATION_CODE_EXPIRED', 'This verification code has expired. Request a new email.');
  if (outcome.kind === 'locked') throw new ApiError(429, 'EMAIL_VERIFICATION_CODE_LOCKED', 'Too many incorrect codes. Request a new email.');
  if (outcome.kind !== 'verified') throw new ApiError(400, 'EMAIL_VERIFICATION_INVALID', 'The verification code is incorrect or unavailable.');
  res.clearCookie(registrationContinuationCookieName, authCookieBaseOptions());
  const continuationMatches = continuation
    && continuation.userId === outcome.userId
    && continuation.email.toLowerCase() === outcome.email.toLowerCase();
  if (!continuationMatches) return ok(res, { verified: true, authenticated: false });

  try {
    const actor = await loadActor(outcome.userId);
    if (!actor || actor.status !== 'active' || actorNeedsEmailVerification(actor)) {
      return ok(res, { verified: true, authenticated: false });
    }
    const refreshToken = await createRefreshSession(actor, req, res);
    return ok(res, {
      verified: true,
      authenticated: true,
      user: actor,
      accessToken: signAccessToken(actor),
      csrfToken: createCsrfToken(refreshToken),
    });
  } catch (sessionError) {
    res.locals.log?.warn({
      requestId: res.locals.requestId,
      errorName: sessionError instanceof Error ? sessionError.name : 'UnknownError',
    }, 'Email verified but automatic sign-in could not be completed');
    return ok(res, { verified: true, authenticated: false });
  }
}

export async function resendEmailVerification(req: Request, res: Response) {
  const input = parse(resendVerificationSchema, req.body);
  const continuation = verifyRegistrationContinuation(
    req.cookies?.[registrationContinuationCookieName] as string | undefined,
    env.REFRESH_TOKEN_SECRET,
  );
  const pendingChallenge = await withTransaction(async (client) => {
    const users = await client.query<VerificationUser>(`SELECT user_id AS id, email::text AS email, account_status AS status,
      email_verified_at, email_verification_required_at
      FROM users WHERE lower(email::text) = lower($1) FOR UPDATE`, [input.email]);
    const user = users.rows[0];
    if (!user || user.status !== 'active' || !user.email_verification_required_at || user.email_verified_at) return null;
    const current = await client.query<{ resend_available_at: Date }>(
      'SELECT resend_available_at FROM email_verification_challenges WHERE user_id = $1 FOR UPDATE',
      [user.id],
    );
    if (current.rows[0] && current.rows[0].resend_available_at > new Date()) return null;
    const challenge = createChallenge(user.id, user.email);
    await client.query(`INSERT INTO email_verification_challenges
      (user_id, code_hash, expires_at, resend_available_at, failed_attempts)
      VALUES ($1, $2, $3, $4, 0)
      ON CONFLICT (user_id) DO UPDATE SET
        code_hash = EXCLUDED.code_hash,
        expires_at = EXCLUDED.expires_at,
        resend_available_at = EXCLUDED.resend_available_at,
        failed_attempts = 0,
        updated_at = now()`,
    [user.id, hashVerificationCode(challenge.code, env.EMAIL_VERIFICATION_CODE_PEPPER), challenge.expiresAt, challenge.resendAvailableAt]);
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json)
      VALUES ($1, 'auth.email_verification_resent', 'users', $2, '{}'::jsonb)`, [user.id, user.id]);
    return challenge;
  });

  if (pendingChallenge) {
    if (
      continuation?.userId === pendingChallenge.userId
      && continuation.email.toLowerCase() === pendingChallenge.email.toLowerCase()
    ) {
      res.cookie(
        registrationContinuationCookieName,
        signRegistrationContinuation({
          userId: pendingChallenge.userId,
          email: pendingChallenge.email,
        }, env.REFRESH_TOKEN_SECRET),
        registrationContinuationCookieOptions(),
      );
    }
    await sendPendingChallenge(pendingChallenge);
  }
  // This response intentionally does not disclose whether an address belongs
  // to a pending account, is already verified, or is subject to cooldown.
  return ok(res, { accepted: true }, 202);
}

export async function forgotPassword(req: Request, res: Response) {
  const input = parse(forgotPasswordSchema, req.body);
  const fingerprint = securityContext(req, res);
  const token = createOpaqueToken();
  const outcome = await withTransaction(async (client) => {
    const user = await client.query<{ user_id: string; email: string; email_verified_at: Date | null }>(`SELECT user_id, email::text AS email, email_verified_at FROM users
      WHERE lower(email::text) = lower($1) AND account_status = 'active' FOR UPDATE`, [input.email]);
    if (!user.rowCount) return { status: 'no_account' as const };
    const account = user.rows[0];

    // An address whose control was never proven must not receive a reset link:
    // whoever registered it first would otherwise keep a foothold on someone
    // else's address. Such accounts belong on the verification resend path,
    // and sign-in would reject them afterwards anyway, so issuing a link here
    // only produces a dead end the user cannot diagnose.
    if (!account.email_verified_at) return { status: 'unverified' as const, userId: account.user_id };

    // Per-account cooldown. The per-IP limiter in app.ts bounds one source;
    // without this, one source within its budget can still send a link to many
    // different inboxes, and a user clicking twice re-sends to their own.
    const recent = await client.query<{ requested_at: Date }>(
      'SELECT requested_at FROM password_reset_challenges WHERE user_id = $1 ORDER BY requested_at DESC LIMIT 1',
      [account.user_id],
    );
    const cooldownMs = env.PASSWORD_RESET_COOLDOWN_SECONDS * 1000;
    if (recent.rows[0] && recent.rows[0].requested_at.getTime() > Date.now() - cooldownMs) {
      return { status: 'throttled' as const, userId: account.user_id };
    }

    await client.query('UPDATE password_reset_challenges SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL', [account.user_id]);
    const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TOKEN_TTL_MINUTES * 60_000);
    await client.query(`INSERT INTO password_reset_challenges (user_id, token_hash, expires_at, requested_ip_hash)
      VALUES ($1, $2, $3, $4)`, [account.user_id, sha256(token), expiresAt, fingerprint.ipHash]);
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, 'auth.password_reset_requested', 'users', $1, jsonb_build_object('outcome', 'pending'), $2)`,
    [account.user_id, res.locals.requestId]);
    return { status: 'issued' as const, userId: account.user_id, email: account.email };
  });

  await recordSecurityEvent(fingerprint, {
    type: outcome.status === 'throttled'
      ? 'auth.reset_throttled'
      : outcome.status === 'unverified' ? 'auth.reset_unverified_account' : 'auth.reset_requested',
    actorUserId: 'userId' in outcome ? outcome.userId : null,
    // The address is never stored, only a keyed fingerprint, which still lets
    // the W7 rules count how many distinct inboxes one source probed.
    context: { subject: emailFingerprint(input.email, env.SECURITY_HASH_PEPPER), outcome: outcome.status },
  }, res);

  if (outcome.status === 'issued') {
    try {
      await sendPasswordResetEmail({ to: outcome.email, resetUrl: passwordResetUrl(env.APP_ORIGIN, token), expiresInMinutes: env.PASSWORD_RESET_TOKEN_TTL_MINUTES });
    } catch {
      await query('UPDATE password_reset_challenges SET consumed_at = now() WHERE user_id = $1 AND token_hash = $2 AND consumed_at IS NULL', [outcome.userId, sha256(token)]);
      res.locals.log?.warn({ requestId: fingerprint.requestId }, 'Password reset email delivery failed');
    }
  }
  // One response for every branch above. A status, code or body that varied by
  // outcome would turn this endpoint into the account-enumeration oracle the
  // whole flow is shaped to avoid.
  return ok(res, { accepted: true }, 202);
}

export async function resetPassword(req: Request, res: Response) {
  const input = parse(resetPasswordSchema, req.body);
  const fingerprint = securityContext(req, res);
  const tokenHash = sha256(input.token);

  // Phase 1: confirm the token is redeemable without consuming it. Gating on
  // this first also stops an anonymous caller using the endpoint as a free
  // relay to the breach API in phase 2.
  const candidate = await query<{ user_id: string; email: string; full_name: string | null }>(
    `SELECT c.user_id, u.email::text AS email, u.full_name
       FROM password_reset_challenges c
       JOIN users u ON u.user_id = c.user_id
      WHERE c.token_hash = $1 AND c.consumed_at IS NULL AND c.expires_at > now()
        AND u.account_status = 'active'`,
    [tokenHash],
  );
  if (!candidate.rowCount) {
    await recordSecurityEvent(fingerprint, {
      type: 'auth.reset_token_rejected', decision: 'deny', context: { reason: 'not_redeemable' },
    }, res);
    throw new ApiError(400, 'PASSWORD_RESET_TOKEN_INVALID', 'The password reset link is invalid or has expired.');
  }
  const subject = candidate.rows[0];

  // Phase 2: policy. Running it before the token is consumed means a weak
  // choice costs the user a retry rather than their only reset link. Routed
  // through the shared gate so registration and reset cannot diverge -- a
  // policy enforced on sign-up but not on reset is one an attacker simply
  // resets around.
  await assertPasswordAcceptable(
    input.password,
    { email: subject.email, displayName: subject.full_name ?? undefined },
    'reset', fingerprint, res, subject.user_id,
  );

  // Phase 3: redeem and rotate atomically. The conditional UPDATE is what
  // enforces single use: two requests racing on one token produce one affected
  // row and one zero.
  const revokedSessions = await withTransaction(async (client) => {
    const consumed = await client.query(
      `UPDATE password_reset_challenges SET consumed_at = now()
        WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
      [tokenHash],
    );
    if (!consumed.rowCount) throw new ApiError(409, 'PASSWORD_RESET_TOKEN_CONSUMED', 'This reset link has already been used.');

    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    await client.query('UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE user_id = $1', [subject.user_id, passwordHash]);
    const sessions = await client.query(`UPDATE refresh_sessions SET revoked_at = now(), revoke_reason = 'password-reset'
      WHERE user_id = $1 AND revoked_at IS NULL`, [subject.user_id]);

    // Gives a locked-out victim a way back in without support intervention,
    // which is what keeps the lockout ladder from being a usable denial of
    // service against a known address.
    await client.query(`UPDATE auth_failure_counters
        SET consecutive_failures = 0, locked_until = NULL, updated_at = now()
      WHERE user_id = $1`, [subject.user_id]);

    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, 'auth.password_reset_completed', 'users', $1, jsonb_build_object('outcome', 'success', 'sessionsRevoked', $3::int), $2)`,
    [subject.user_id, res.locals.requestId, sessions.rowCount ?? 0]);
    return sessions.rowCount ?? 0;
  });

  await recordSecurityEvent(fingerprint, {
    type: 'auth.reset_completed', actorUserId: subject.user_id, context: { sessionsRevoked: revokedSessions },
  }, res);
  await recordSecurityEvent(fingerprint, {
    type: 'session.revoked_all', actorUserId: subject.user_id,
    context: { reason: 'password-reset', count: revokedSessions },
  }, res);

  // ASVS 2.2.3. For an account holder who did not do this, the notification is
  // the only signal they will get. Detached: a mail outage must not fail a
  // reset that already succeeded.
  sendPasswordChangedEmail({ to: subject.email }).catch(() => {
    res.locals.log?.warn({ requestId: fingerprint.requestId }, 'Password change notification failed');
  });

  res.clearCookie(refreshCookieName, refreshCookieOptions());
  // No session is issued. The token arrived in a URL, and URLs leak -- into
  // history, into shared screens. Trading one directly for a session would
  // make every such leak an account takeover.
  return ok(res, { reset: true, signInRequired: true });
}

export async function login(req: Request, res: Response) {
  const input = parse(loginSchema, req.body);
  const fingerprint = securityContext(req, res);
  const found = await query<{ id: string; password_hash: string }>('SELECT user_id AS id, password_hash FROM users WHERE lower(email::text) = lower($1)', [input.email]);
  const record = found.rows[0] ?? null;
  const lock = record ? await readLockState(record.id) : null;

  // One argon2 verification is always spent, whether or not the address
  // resolved and whether or not the account is locked. Short-circuiting either
  // case reopens the timing oracle: argon2id costs tens to hundreds of
  // milliseconds, so "no such account" used to return an order of magnitude
  // faster than "wrong password" and made this endpoint a user-enumeration
  // oracle regardless of how the error message was worded.
  const passwordMatches = await verifyPasswordConstantWork(record?.password_hash ?? null, input.password);

  if (record && lock?.locked) {
    await recordSecurityEvent(fingerprint, {
      type: 'auth.login_blocked', actorUserId: record.id, decision: 'lock',
      context: {
        lockedUntil: lock.lockedUntil,
        consecutiveFailures: lock.consecutiveFailures,
        // A correct password arriving during a lock means the guessing already
        // succeeded and only the cooldown is holding the attacker off. It is
        // the most actionable signal this endpoint produces.
        passwordMatched: passwordMatches,
      },
    }, res);
    // Same status, code and message as a wrong password: a distinguishable
    // "locked" response would confirm the address exists.
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }

  if (!record || !passwordMatches) {
    if (record) {
      const outcome = await registerFailure(record.id, env.LOGIN_FAILURE_DECAY_HOURS * 3600);
      await recordSecurityEvent(fingerprint, {
        type: 'auth.login_failed', actorUserId: record.id,
        context: { consecutiveFailures: outcome.consecutiveFailures },
      }, res);
      if (outcome.newlyLocked) {
        await recordSecurityEvent(fingerprint, {
          type: outcome.consecutiveFailures >= lockoutAlertThreshold ? 'auth.account_lock_escalated' : 'auth.account_locked',
          actorUserId: record.id, decision: 'lock',
          context: { consecutiveFailures: outcome.consecutiveFailures, lockedUntil: outcome.lockedUntil },
        }, res);
      }
    } else {
      await recordSecurityEvent(fingerprint, {
        type: 'auth.login_failed',
        context: { subject: emailFingerprint(input.email, env.SECURITY_HASH_PEPPER), accountExists: false },
      }, res);
    }
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }

  const actor = await loadActor(record.id);
  if (!actor || actor.status !== 'active') {
    // Correct credentials against a suspended or deleted account. Not a
    // guessing failure, so it must not advance the ladder, but worth recording:
    // it usually means a credential dump is being replayed.
    await recordSecurityEvent(fingerprint, {
      type: 'auth.login_denied_status', actorUserId: record.id, decision: 'deny',
      context: { status: actor?.status ?? 'unknown' },
    }, res);
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }
  if (actorNeedsEmailVerification(actor)) {
    await recordSecurityEvent(fingerprint, {
      type: 'auth.unverified_login_attempt', actorUserId: actor.id, decision: 'deny',
    }, res);
    throw new ApiError(403, 'EMAIL_VERIFICATION_REQUIRED', 'Verify your email address before signing in.');
  }

  await clearFailures(actor.id);
  const refreshToken = await createRefreshSession(actor, req, res);
  await recordSecurityEvent(fingerprint, {
    type: 'auth.login_succeeded', actorUserId: actor.id,
    context: { clearedFailures: lock?.consecutiveFailures ?? 0 },
  }, res);
  return ok(res, { user: actor, accessToken: signAccessToken(actor), csrfToken: createCsrfToken(refreshToken) });
}

export async function csrf(req: Request, res: Response) {
  if (!originIsAllowed(req)) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'The request origin is not allowed.');
  const token = req.cookies?.[refreshCookieName] as string | undefined;
  return ok(res, { csrfToken: token ? createCsrfToken(token) : null });
}

export async function refresh(req: Request, res: Response) {
  if (!originIsAllowed(req)) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'The request origin is not allowed.');
  const token = req.cookies?.[refreshCookieName] as string | undefined;
  if (!token) throw new ApiError(401, 'REFRESH_TOKEN_MISSING', 'Refresh session is missing.');
  assertCsrfToken(req, token);
  const session = await query<{ id: string; user_id: string; revoked_at: Date | null; expires_at: Date }>('SELECT session_id AS id, user_id, revoked_at, expires_at FROM refresh_sessions WHERE token_hash = $1', [sha256(token)]);
  if (!session.rowCount) throw new ApiError(401, 'REFRESH_TOKEN_INVALID', 'Refresh session is invalid.');
  const current = session.rows[0];
  if (current.revoked_at) {
    const revoked = await query('UPDATE refresh_sessions SET revoked_at = now(), revoke_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL', [current.user_id, 'refresh-token-reuse']);
    // Critical severity: replay of a rotated token is either stolen session
    // material or a broken client, and the two are indistinguishable here. It
    // pages an operator by design.
    const reuseFingerprint = securityContext(req, res);
    await recordSecurityEvent(reuseFingerprint, {
      type: 'session.refresh_reused', actorUserId: current.user_id, decision: 'deny',
      context: { sessionsRevoked: revoked.rowCount ?? 0 },
    }, res);
    await recordSecurityEvent(reuseFingerprint, {
      type: 'session.revoked_all', actorUserId: current.user_id,
      context: { reason: 'refresh-token-reuse', count: revoked.rowCount ?? 0 },
    }, res);
    throw new ApiError(401, 'REFRESH_TOKEN_REUSED', 'Refresh session is no longer valid.');
  }
  if (current.expires_at <= new Date()) throw new ApiError(401, 'REFRESH_TOKEN_EXPIRED', 'Refresh session has expired.');
  const actor = await loadActor(current.user_id);
  if (!actor || actor.status !== 'active' || actorNeedsEmailVerification(actor)) throw new ApiError(401, 'ACCOUNT_UNAVAILABLE', 'Account is unavailable.');
  const newToken = createOpaqueToken();
  await withTransaction(async (client) => {
    const next = await client.query<{ id: string }>(`INSERT INTO refresh_sessions (user_id, token_hash, expires_at, user_agent, ip_hash) VALUES ($1, $2, $3, $4, $5) RETURNING session_id AS id`, [actor.id, sha256(newToken), new Date(Date.now() + refreshLifetimeMs), req.get('user-agent')?.slice(0, 500) ?? null, sha256(req.ip || 'unknown')]);
    await client.query('UPDATE refresh_sessions SET revoked_at = now(), revoke_reason = $2, replaced_by_session_id = $3 WHERE session_id = $1', [current.id, 'rotated', next.rows[0].id]);
  });
  res.cookie(refreshCookieName, newToken, refreshCookieOptions());
  return ok(res, { user: actor, accessToken: signAccessToken(actor), csrfToken: createCsrfToken(newToken) });
}

export async function logout(req: Request, res: Response) {
  if (!originIsAllowed(req)) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'The request origin is not allowed.');
  const token = req.cookies?.[refreshCookieName] as string | undefined;
  if (token) {
    assertCsrfToken(req, token);
    await query('UPDATE refresh_sessions SET revoked_at = now(), revoke_reason = $2 WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(token), 'logout']);
  }
  res.clearCookie(refreshCookieName, refreshCookieOptions());
  return ok(res, { loggedOut: true });
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.get('authorization');
    if (!header?.startsWith('Bearer ')) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication is required.');
    const payload = jwt.verify(header.slice(7), env.ACCESS_TOKEN_SECRET);
    if (typeof payload === 'string' || !payload.sub) throw new ApiError(401, 'TOKEN_INVALID', 'Authentication token is invalid.');
    const actor = await loadActor(payload.sub);
    if (!actor || actor.status !== 'active' || actorNeedsEmailVerification(actor)) throw new ApiError(401, 'ACCOUNT_UNAVAILABLE', 'Account is unavailable.');
    res.locals.actor = actor;
    next();
  } catch (error) {
    next(error instanceof ApiError ? error : new ApiError(401, 'TOKEN_INVALID', 'Authentication token is invalid.'));
  }
}

export function requireRole(...roles: string[]) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const actor = res.locals.actor as Actor | undefined;
    if (!actor || !roles.some((role) => actor.roles.includes(role))) return next(new ApiError(403, 'FORBIDDEN', 'You are not allowed to perform this action.'));
    return next();
  };
}

export async function me(_req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const result = await query(`SELECT u.full_name, p.display_name, p.phone, p.location, p.bio,
      EXISTS (SELECT 1 FROM trainer_certifications tc WHERE tc.trainer_user_id = u.user_id AND tc.certification_status = 'approved') AS trainer_operational
    FROM users u LEFT JOIN profiles p ON p.user_id = u.user_id WHERE u.user_id = $1`, [actor.id]);
  return ok(res, { ...actor, profile: result.rowCount ? {
    displayName: result.rows[0].display_name ?? result.rows[0].full_name,
    phone: result.rows[0].phone, location: result.rows[0].location, bio: result.rows[0].bio,
  } : null, capabilities: {
    trainerOperational: Boolean(result.rows[0]?.trainer_operational),
    canCreateCourse: actor.roles.includes('trainer') && Boolean(result.rows[0]?.trainer_operational),
    canCreateContent: actor.roles.includes('creator'),
    canPurchase: actor.roles.includes('member') && !actor.roles.includes('admin'),
  } });
}

export async function updateMe(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(z.object({
    fullName: z.string().trim().min(1).max(120).optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    location: z.string().trim().max(160).nullable().optional(),
    bio: z.string().trim().max(2000).nullable().optional(),
  }).refine((value) => Object.keys(value).length > 0), req.body);
  const fullName = input.fullName ?? input.displayName;
  const has = (field: string) => Object.prototype.hasOwnProperty.call(input, field);
  const result = await withTransaction(async (client) => {
    const user = fullName ? await client.query(`UPDATE users SET full_name = $2, updated_at = now() WHERE user_id = $1 RETURNING full_name`, [actor.id, fullName]) : null;
    await client.query(`UPDATE profiles SET
      display_name = CASE WHEN $2 THEN $3 ELSE display_name END,
      phone = CASE WHEN $4 THEN $5 ELSE phone END,
      location = CASE WHEN $6 THEN $7 ELSE location END,
      bio = CASE WHEN $8 THEN $9 ELSE bio END,
      updated_at = now() WHERE user_id = $1`,
      [actor.id, Boolean(fullName), fullName ?? null, has('phone'), input.phone ?? null, has('location'), input.location ?? null, has('bio'), input.bio ?? null]);
    return user?.rows[0]?.full_name ?? input.displayName ?? null;
  });
  return ok(res, { displayName: result });
}
