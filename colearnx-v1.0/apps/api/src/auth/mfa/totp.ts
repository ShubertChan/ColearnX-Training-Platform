import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) over HMAC-SHA-1, with RFC 4648 base32 for secret transport.
 *
 * WHY THIS IS IMPLEMENTED HERE RATHER THAN PULLED FROM A PACKAGE
 *
 * TOTP is not a cryptographic primitive; it is a short, fully specified
 * construction over HMAC, and HMAC comes from node:crypto. Nothing novel is
 * being invented. What implementing it buys is verifiability: this file is
 * checked against the official RFC 6238 appendix B test vectors in
 * totp.test.ts, so its correctness is demonstrated rather than assumed.
 *
 * SHA-1 is mandated by the interoperable profile every authenticator app
 * implements. It is used here as a MAC, not as a collision-resistant hash, and
 * HMAC-SHA-1 has no practical break in that role. Choosing SHA-256 would be
 * marginally stronger on paper and would silently fail in most authenticator
 * apps, which is a worse outcome.
 */

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += base32Alphabet[(value << (5 - bits)) & 31];
  // No '=' padding: authenticator apps accept unpadded secrets and padding is
  // a common source of copy-paste errors during manual entry.
  return output;
}

export function base32Decode(input: string): Buffer {
  // Tolerant of what users actually paste: lower case, spaces, padding.
  const cleaned = input.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of cleaned) {
    const index = base32Alphabet.indexOf(character);
    if (index < 0) throw new Error('Invalid base32 character in secret.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** 160 bits, matching the HMAC-SHA-1 block the RFC recommends. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export const totpPeriodSeconds = 30;
export const totpDigits = 6;

/** The counter value for a moment in time. Exposed so replay state can key on it. */
export const totpStep = (atMs: number) => Math.floor(atMs / 1000 / totpPeriodSeconds);

export function totpCodeForStep(secretBase32: string, step: number, digits = totpDigits): string {
  const counter = Buffer.alloc(8);
  // writeBigUInt64BE rather than two 32-bit writes: the counter is 64-bit in
  // the RFC and will exceed 32 bits in the year 6053, but more usefully this
  // avoids a whole class of sign-extension mistakes today.
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  // Dynamic truncation, RFC 4226 section 5.3.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export type TotpVerification = { valid: false } | { valid: true; step: number };

/**
 * Verifies a submitted code against a window of steps.
 *
 * The window exists because phone clocks drift; +/-1 step accepts up to 30
 * seconds of skew in each direction, which is the common interoperable
 * default. Widening it multiplies an attacker's guessing surface linearly, so
 * it is not configurable upward from here.
 *
 * `afterStep` rejects any code from a step at or before the last one this
 * account used. Without it a code stays valid for its whole window, so an
 * attacker who observes one -- over the shoulder, from a phishing page, from a
 * log -- can replay it. The returned step is what the caller must persist.
 *
 * Comparison is constant time. The code is low entropy and short lived, so a
 * timing leak here is not the most pressing risk, but there is no reason to
 * leak it either.
 */
export function verifyTotp(
  secretBase32: string,
  submitted: string,
  atMs: number,
  afterStep: number | null,
  windowSteps = 1,
): TotpVerification {
  const normalised = submitted.replace(/\s/g, '');
  if (!/^[0-9]{6}$/.test(normalised)) return { valid: false };
  const current = totpStep(atMs);
  for (let offset = -windowSteps; offset <= windowSteps; offset += 1) {
    const step = current + offset;
    if (afterStep !== null && step <= afterStep) continue;
    const expected = Buffer.from(totpCodeForStep(secretBase32, step), 'utf8');
    const candidate = Buffer.from(normalised, 'utf8');
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) {
      return { valid: true, step };
    }
  }
  return { valid: false };
}

/**
 * The otpauth:// URI an authenticator app consumes.
 *
 * The label carries the account address so a user with several accounts can
 * tell the entries apart, and the issuer is repeated as a parameter because
 * some apps read only one of the two positions.
 */
export function otpauthUri(secretBase32: string, account: string, issuer = 'CoLearnX'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(totpDigits),
    period: String(totpPeriodSeconds),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
