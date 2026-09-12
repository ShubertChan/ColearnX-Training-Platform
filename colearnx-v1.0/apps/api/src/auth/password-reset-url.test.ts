import assert from 'node:assert/strict';
import test from 'node:test';
import { passwordResetUrl } from './password-reset-url.js';

test('reset email opens the deployed hash route with a correctly encoded token', () => {
  const token = 'synthetic+token/with?&=#';
  const url = new URL(passwordResetUrl('https://staging.example.test', token));
  assert.equal(url.origin, 'https://staging.example.test');
  assert.equal(url.pathname, '/');
  assert.equal(url.search, '', 'token must not go to the CDN as a path query');
  const route = new URL(url.hash.slice(1), url.origin);
  assert.equal(route.pathname, '/reset-password');
  assert.equal(route.searchParams.get('token'), token);
});

test('reset links also support local testing and reject empty or non-HTTP inputs', () => {
  assert.equal(passwordResetUrl('http://localhost:5173', 'synthetic'), 'http://localhost:5173/#/reset-password?token=synthetic');
  assert.throws(() => passwordResetUrl('https://example.test', ''));
  assert.throws(() => passwordResetUrl('file:///tmp', 'synthetic'));
});
