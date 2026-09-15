import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Single-use recovery codes, the escape hatch for a lost authenticator.
 *
 * WITHOUT THESE, TWO-FACTOR IS A LIABILITY. A user who loses their phone is
 * permanently locked out, and the only remedy is an operator who disables MFA
 * on request -- which is itself a social-engineering target and, in practice,
 * becomes the weakest link in the whole scheme. Recovery codes move that
 * decision to something the user holds.
 *
 * ENTROPY AND STORAGE. Each code carries 100 bits (20 base32 characters), so
 * it is stored as a keyed digest rather than an argon2 hash. That is the same
 * reasoning as the password reset token: argon2 exists to slow down guessing a
 * low-entropy human secret, and there is nothing to guess here. It also
 * matters practically -- verifying a submitted code against ten argon2 hashes
 * would cost a full second per attempt.
 *
 * The digest is keyed with the server pepper, so a database dump alone does
 * not permit an offline search even against the unlikely event of a weak
 * generator.
 */

const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const codeLength = 20;
export const recoveryCodeCount = 10;

/**
 * Ambiguous characters are excluded from the alphabet above: no I/1, no O/0.
 * These codes get written on paper and typed back months later, and a code
 * that cannot be transcribed reliably is a code that fails when it matters.
 */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(codeLength);
  let code = '';
  for (let index = 0; index < codeLength; index += 1) {
    code += codeAlphabet[bytes[index] % codeAlphabet.length];
  }
  return code;
}

export const generateRecoveryCodes = () =>
  Array.from({ length: recoveryCodeCount }, generateRecoveryCode);

/** Grouped for display and transcription: XXXXX-XXXXX-XXXXX-XXXXX. */
export const formatRecoveryCode = (code: string) =>
  (code.match(/.{1,5}/g) ?? [code]).join('-');

/** Accepts whatever the user types back: spacing, hyphens, case. */
export const normaliseRecoveryCode = (input: string) =>
  input.toUpperCase().replace(/[^A-Z0-9]/g, '');

export const hashRecoveryCode = (code: string, pepper: string) =>
  createHmac('sha256', pepper).update(`recovery:${normaliseRecoveryCode(code)}`).digest('hex');

/**
 * Constant-time comparison against a stored digest. Both sides are fixed-length
 * hex, so lengths always match and timingSafeEqual cannot throw.
 */
export function recoveryCodeMatches(submitted: string, storedHash: string, pepper: string): boolean {
  const candidate = Buffer.from(hashRecoveryCode(submitted, pepper), 'utf8');
  const expected = Buffer.from(storedHash, 'utf8');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}
