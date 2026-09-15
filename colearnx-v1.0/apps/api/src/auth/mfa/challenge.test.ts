import assert from 'node:assert/strict';
import test from 'node:test';
import { issueChallenge, verifyChallenge } from './challenge.js';

const secret = 's'.repeat(48);
const now = 1_700_000_000_000;

test('a fresh token verifies and returns its subject', () => {
  const token = issueChallenge('mfa-continuation', 'user-1', 300, secret, now);
  assert.deepEqual(verifyChallenge(token, 'mfa-continuation', secret, now), { valid: true, subject: 'user-1' });
});

test('an MFA token cannot be presented as a step-up token', () => {
  // The confused-deputy case this exists to prevent: passing the first factor
  // must not silently authorise the actions step-up gates.
  const token = issueChallenge('mfa-continuation', 'user-1', 300, secret, now);
  assert.equal(verifyChallenge(token, 'step-up', secret, now).valid, false);
});

test('expiry is enforced', () => {
  const token = issueChallenge('step-up', 'user-1', 300, secret, now);
  assert.equal(verifyChallenge(token, 'step-up', secret, now + 299_000).valid, true);
  const late = verifyChallenge(token, 'step-up', secret, now + 301_000);
  assert.equal(late.valid, false);
  assert.equal(late.valid === false && late.reason, 'expired');
});

test('a different secret does not verify', () => {
  const token = issueChallenge('step-up', 'user-1', 300, secret, now);
  assert.equal(verifyChallenge(token, 'step-up', 'x'.repeat(48), now).valid, false);
});

test('a tampered payload is rejected on the signature, not on parsing', () => {
  // The signature is checked first, so a forged payload never reaches
  // JSON.parse or anything downstream.
  const token = issueChallenge('step-up', 'user-1', 300, secret, now);
  const [, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ p: 'step-up', s: 'admin', e: now + 999_999, n: 'x' }), 'utf8').toString('base64url');
  const result = verifyChallenge(`${forged}.${mac}`, 'step-up', secret, now);
  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.reason, 'signature');
});

test('malformed input never throws', () => {
  for (const bad of ['', 'x', 'a.b.c', '....', 'not-base64.sig']) {
    assert.equal(verifyChallenge(bad, 'step-up', secret, now).valid, false, bad);
  }
});

test('two tokens for the same subject in the same instant differ', () => {
  const a = issueChallenge('step-up', 'user-1', 300, secret, now);
  const b = issueChallenge('step-up', 'user-1', 300, secret, now);
  assert.notEqual(a, b);
});
