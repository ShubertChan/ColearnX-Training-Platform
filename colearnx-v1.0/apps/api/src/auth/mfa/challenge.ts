import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived, purpose-bound tokens for the two places authentication is split
 * across more than one request: the second factor at sign-in, and step-up
 * re-authentication before a high-risk action.
 *
 * NO SERVER STATE. Both flows last under ten minutes and are single-use only
 * in the sense that the action they authorise happens once. A table would add
 * a write, a read and a cleanup job to every sign-in for no security gain that
 * the expiry and purpose binding do not already provide.
 *
 * PURPOSE BINDING IS THE POINT. The purpose is inside the signed payload, so an
 * MFA continuation token cannot be presented as a step-up token. Without it,
 * passing the first factor would silently authorise the administrative actions
 * that step-up exists to gate -- exactly the confused-deputy problem that makes
 * generic "signed blobs" dangerous.
 *
 * KEY SEPARATION. The signing key is derived from a dedicated secret with a
 * per-purpose label rather than reusing ACCESS_TOKEN_SECRET or
 * REFRESH_TOKEN_SECRET. Reusing one key across purposes is finding F-16 in the
 * threat model; repeating it here while building a control that depends on
 * purpose separation would be self-defeating.
 */

export type ChallengePurpose = 'mfa-continuation' | 'step-up';

type Payload = { p: ChallengePurpose; s: string; e: number; n: string; b?: string };

const sign = (body: string, secret: string, purpose: ChallengePurpose) =>
  createHmac('sha256', `${secret}:${purpose}`).update(body).digest('base64url');

export function issueChallenge(
  purpose: ChallengePurpose,
  subject: string,
  ttlSeconds: number,
  secret: string,
  nowMs = Date.now(),
  sessionId?: string,
): string {
  const payload: Payload = {
    p: purpose,
    s: subject,
    e: nowMs + ttlSeconds * 1000,
    // Makes two tokens issued in the same millisecond for the same subject
    // distinct, so one cannot be mistaken for the other in a log.
    n: randomBytes(9).toString('base64url'),
    ...(sessionId ? { b: sessionId } : {}),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret, purpose)}`;
}

export type ChallengeResult =
  | { valid: true; subject: string; sessionId?: string }
  | { valid: false; reason: 'malformed' | 'signature' | 'expired' | 'purpose' };

export function verifyChallenge(
  token: string,
  purpose: ChallengePurpose,
  secret: string,
  nowMs = Date.now(),
): ChallengeResult {
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'malformed' };
  const [body, mac] = parts;

  // Signature is checked before the payload is parsed or trusted for anything,
  // so a forged payload never reaches JSON.parse or any downstream logic.
  const expected = Buffer.from(sign(body, secret, purpose), 'utf8');
  const candidate = Buffer.from(mac, 'utf8');
  if (expected.length !== candidate.length || !timingSafeEqual(expected, candidate)) {
    return { valid: false, reason: 'signature' };
  }

  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload;
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (typeof payload?.s !== 'string' || typeof payload?.e !== 'number'
    || (payload.b !== undefined && typeof payload.b !== 'string')) {
    return { valid: false, reason: 'malformed' };
  }
  // Redundant given the per-purpose key, and kept anyway: if the key derivation
  // is ever changed, this is what still stops a token being reused across
  // purposes.
  if (payload.p !== purpose) return { valid: false, reason: 'purpose' };
  if (payload.e <= nowMs) return { valid: false, reason: 'expired' };
  return { valid: true, subject: payload.s, ...(payload.b ? { sessionId: payload.b } : {}) };
}
