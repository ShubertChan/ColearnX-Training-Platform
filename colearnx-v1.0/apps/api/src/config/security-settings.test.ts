import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { checkProxyTopology, resolveSecuritySecret } from './security-settings.js';

test('development derivation preserves existing fingerprints and deployed environments require independent keys', () => {
  const seed = 'test'.repeat(12);
  assert.equal(resolveSecuritySecret('SECURITY_HASH_PEPPER', '', seed, false),
    createHash('sha256').update('colearnx-local-security-pepper:' + seed).digest('hex'));
  assert.notEqual(resolveSecuritySecret('MFA_SECRET_KEY', '', seed, false), resolveSecuritySecret('MFA_CHALLENGE_SECRET', '', seed, false));
  assert.throws(() => resolveSecuritySecret('MFA_SECRET_KEY', '', seed, true));
  assert.throws(() => resolveSecuritySecret('MFA_SECRET_KEY', 'too-short', seed, false));
  assert.equal(resolveSecuritySecret('MFA_SECRET_KEY', seed, '', true), seed);
});

test('the deployed staging topology refuses a spoofable second hop and a silent default', () => {
  const staging = 'https://api-staging.colearnx.net';
  assert.throws(() => checkProxyTopology(true, '2', 2, staging));
  assert.throws(() => checkProxyTopology(true, undefined, 1, staging));
  assert.doesNotThrow(() => checkProxyTopology(true, '1', 1, staging));
  assert.doesNotThrow(() => checkProxyTopology(false, '0', 0, 'http://localhost'));
});
