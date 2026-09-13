import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export const verificationCodeLength = 8;

// Migration 004 grandfathered existing accounts with both timestamps NULL.
// Use the same eligibility rule for sign-in and password recovery.
export function requiresEmailVerification(requiredAt: Date | null, verifiedAt: Date | null) {
  return Boolean(requiredAt && !verifiedAt);
}

export function createVerificationCode() {
  return randomInt(10 ** (verificationCodeLength - 1), 10 ** verificationCodeLength).toString();
}

export function hashVerificationCode(code: string, pepper: string) {
  return createHmac('sha256', pepper).update(code).digest('hex');
}

export function verificationCodeMatches(code: string, expectedHash: string, pepper: string) {
  const actual = Buffer.from(hashVerificationCode(code, pepper), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verificationWindow(now: Date, ttlMinutes: number, resendCooldownSeconds: number) {
  return {
    expiresAt: new Date(now.getTime() + ttlMinutes * 60 * 1000),
    resendAvailableAt: new Date(now.getTime() + resendCooldownSeconds * 1000),
  };
}
