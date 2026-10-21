import type { Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { env } from '../config/env.js';
import { query, withTransaction } from '../db/database.js';
import { createOpaqueToken, sha256 } from '../lib/crypto.js';
import { ApiError, ok } from '../lib/http.js';
import { parse } from '../lib/validation.js';
import { completePrimarySignIn } from './auth.js';
import { googleIdentity } from './google-identity.js';
import { resolveGoogleAccount } from './google-account.js';

const google = new OAuth2Client({ transporterOptions: { timeout: 5000, retry: false } });
const browserCookie = 'colearnx_google_browser';
const lifetimeMs = 10 * 60_000;
const loginSchema = z.object({
  credential: z.string().min(100).max(10000),
  acceptedTerms: z.boolean().optional(),
  ageAcknowledged: z.boolean().optional(),
}).strict();

function assertEnabledOrigin(req: Request) {
  if (!env.GOOGLE_CLIENT_ID) throw new ApiError(503, 'GOOGLE_NOT_CONFIGURED', 'Google sign-in is currently unavailable. Use email and password or try again later.');
  if (req.get('origin') !== env.APP_ORIGIN) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'The request origin is not allowed.');
}

export function googleConfig(_req: Request, res: Response) {
  return ok(res, { enabled: Boolean(env.GOOGLE_CLIENT_ID), clientId: env.GOOGLE_CLIENT_ID || null });
}

export async function googleChallenge(req: Request, res: Response) {
  assertEnabledOrigin(req);
  const cookie = req.cookies?.[browserCookie];
  const browser = typeof cookie === 'string' && /^[A-Za-z0-9_-]{64}$/.test(cookie) ? cookie : createOpaqueToken();
  const nonce = createOpaqueToken();
  const expiresAt = new Date(Date.now() + lifetimeMs);
  await query('DELETE FROM google_login_challenges WHERE expires_at <= now()');
  await query('INSERT INTO google_login_challenges (nonce_hash, browser_hash, expires_at) VALUES ($1, $2, $3)', [sha256(nonce), sha256(browser), expiresAt]);
  res.cookie(browserCookie, browser, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production' || env.NODE_ENV === 'staging',
    sameSite: env.NODE_ENV === 'production' || env.NODE_ENV === 'staging' ? 'none' : 'lax',
    // Host-only: a sibling subdomain must not be able to replace this binding.
    path: '/api/v1/auth/google', maxAge: lifetimeMs,
  });
  return ok(res, { nonce, expiresAt: expiresAt.toISOString() });
}

export async function googleLogin(req: Request, res: Response) {
  assertEnabledOrigin(req);
  const input = parse(loginSchema, req.body);
  const browser = req.cookies?.[browserCookie];
  if (typeof browser !== 'string' || !/^[A-Za-z0-9_-]{64}$/.test(browser)) {
    throw new ApiError(401, 'GOOGLE_CHALLENGE_INVALID', 'Google sign-in expired. Please try again and allow cookies.');
  }
  let ticket;
  try {
    ticket = await google.verifyIdToken({ idToken: input.credential, audience: env.GOOGLE_CLIENT_ID });
  } catch {
    // Never log Google's errors: they can embed the submitted bearer token.
    throw new ApiError(401, 'GOOGLE_CREDENTIAL_INVALID', 'Google sign-in expired or could not be verified. Please try again.');
  }
  const identity = googleIdentity(ticket.getPayload());
  const outcome = await withTransaction(async (client) => {
    // A row lock + DELETE prevents parallel requests or replays issuing two
    // sessions. Rollback leaves the nonce usable for the consent continuation.
    const challenge = await client.query(`SELECT nonce_hash FROM google_login_challenges
      WHERE nonce_hash = $1 AND browser_hash = $2 AND expires_at > now() FOR UPDATE`,
    [sha256(identity.nonce), sha256(browser)]);
    if (!challenge.rowCount) throw new ApiError(401, 'GOOGLE_CHALLENGE_INVALID', 'Google sign-in expired. Please try again and allow cookies.');
    const account = await resolveGoogleAccount(client, identity, input.acceptedTerms === true && input.ageAcknowledged === true);
    if ('registrationRequired' in account) return account;
    await client.query('DELETE FROM google_login_challenges WHERE nonce_hash = $1', [sha256(identity.nonce)]);
    return account;
  });
  if ('registrationRequired' in outcome) return ok(res, { registrationRequired: true }, 202);
  return completePrimarySignIn(outcome.userId, req, res, 'google');
}
