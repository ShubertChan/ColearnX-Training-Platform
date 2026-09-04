import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import {
  signRegistrationContinuation,
  verifyRegistrationContinuation,
} from './registration-continuation.js';

const secret = 'test-registration-continuation-secret-long-enough';

test('registration continuation is bound to the registering user and email', () => {
  const token = signRegistrationContinuation({
    userId: 'b3c71f77-1841-4df1-8676-f1fa662cf196',
    email: 'member@example.com',
  }, secret);

  assert.deepEqual(verifyRegistrationContinuation(token, secret), {
    userId: 'b3c71f77-1841-4df1-8676-f1fa662cf196',
    email: 'member@example.com',
  });
  const payload = jwt.decode(token);
  assert.equal(typeof payload === 'object' && payload !== null && payload.exp! - payload.iat!, 60 * 60);
});

test('registration continuation rejects a different secret or purpose', () => {
  const token = signRegistrationContinuation({
    userId: 'b3c71f77-1841-4df1-8676-f1fa662cf196',
    email: 'member@example.com',
  }, secret);
  const wrongPurpose = jwt.sign({
    sub: 'b3c71f77-1841-4df1-8676-f1fa662cf196',
    email: 'member@example.com',
    purpose: 'password-reset',
  }, secret, { audience: 'colearnx-registration', issuer: 'colearnx-api' });

  assert.equal(verifyRegistrationContinuation(token, `${secret}-other`), null);
  assert.equal(verifyRegistrationContinuation(wrongPurpose, secret), null);
});
