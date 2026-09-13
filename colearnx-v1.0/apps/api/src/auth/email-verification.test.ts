import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createVerificationCode,
  hashVerificationCode,
  requiresEmailVerification,
  verificationCodeLength,
  verificationCodeMatches,
  verificationWindow,
} from './email-verification.js';

test('legacy accounts retain sign-in and recovery eligibility without verification timestamps', () => {
  assert.equal(requiresEmailVerification(null, null), false);
});

test('pending registrations must verify before sign-in or password recovery', () => {
  assert.equal(requiresEmailVerification(new Date('2026-09-01T00:00:00Z'), null), true);
});

test('verified accounts can sign in and recover their passwords', () => {
  const verifiedAt = new Date('2026-09-01T00:01:00Z');
  assert.equal(requiresEmailVerification(new Date('2026-09-01T00:00:00Z'), verifiedAt), false);
  assert.equal(requiresEmailVerification(null, verifiedAt), false);
});

test('verification codes are fixed-length numeric values', () => {
  for (let index = 0; index < 25; index += 1) {
    const code = createVerificationCode();
    assert.match(code, new RegExp(`^\\d{${verificationCodeLength}}$`));
  }
});

test('verification code comparison uses a keyed hash', () => {
  const pepper = 'test-only-verification-pepper-that-is-long-enough';
  const hash = hashVerificationCode('12345678', pepper);

  assert.equal(verificationCodeMatches('12345678', hash, pepper), true);
  assert.equal(verificationCodeMatches('87654321', hash, pepper), false);
  assert.equal(verificationCodeMatches('12345678', hash, `${pepper}-different`), false);
});

test('verification window applies the configured expiry and resend cooldown', () => {
  const window = verificationWindow(new Date('2026-08-31T00:00:00.000Z'), 10, 60);

  assert.equal(window.expiresAt.toISOString(), '2026-08-31T00:10:00.000Z');
  assert.equal(window.resendAvailableAt.toISOString(), '2026-08-31T00:01:00.000Z');
});
