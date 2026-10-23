import type { TokenPayload } from 'google-auth-library';
import { z } from 'zod';
import { ApiError } from '../lib/http.js';

export type GoogleIdentity = { subject: string; email: string; name: string; nonce: string };

// Called ONLY after Google's library has checked signature, issuer and audience.
export function googleIdentity(payload: TokenPayload | undefined): GoogleIdentity {
  const claims = payload as (TokenPayload & { nonce?: string }) | undefined;
  const email = z.string().email().max(320).safeParse(claims?.email);
  if (!claims?.sub || !email.success || claims.email_verified !== true
    || !claims.exp || claims.exp * 1000 <= Date.now()
    || !claims.iat || claims.iat * 1000 > Date.now() + 60_000
    || typeof claims.nonce !== 'string' || !/^[A-Za-z0-9_-]{64}$/.test(claims.nonce)) {
    throw new ApiError(401, 'GOOGLE_CREDENTIAL_INVALID', 'Google sign-in expired or could not be verified. Please try again.');
  }
  // Google is not the current authority for third-party mailboxes, even when
  // email_verified is true. Never use that claim alone to take over an account.
  if (!email.data.toLowerCase().endsWith('@gmail.com') && !claims.hd) {
    throw new ApiError(403, 'GOOGLE_EMAIL_NOT_AUTHORITATIVE', 'Use a Gmail or Google Workspace account, or sign in with your email and password.');
  }
  return {
    subject: claims.sub,
    email: email.data.toLowerCase(),
    name: claims.name?.trim().slice(0, 120) || email.data.split('@')[0].slice(0, 120),
    nonce: claims.nonce,
  };
}
