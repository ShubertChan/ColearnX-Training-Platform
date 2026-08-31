import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export const verificationCodeLength = 8;

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
