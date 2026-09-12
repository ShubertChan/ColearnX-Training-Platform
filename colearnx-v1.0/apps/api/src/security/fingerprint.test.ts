import assert from 'node:assert/strict';
import test from 'node:test';
import { emailFingerprint, fingerprint, ipFingerprint, userAgentFingerprint } from './fingerprint.js';

const pepper = 'a'.repeat(64);

test('the same input under the same pepper is stable', () => {
  assert.equal(ipFingerprint('203.0.113.7', pepper), ipFingerprint('203.0.113.7', pepper));
});

test('a different pepper yields a different digest', () => {
  // This is the whole point of F-05: without the key, the digest cannot be
  // reproduced offline from a guessed address.
  assert.notEqual(ipFingerprint('203.0.113.7', pepper), ipFingerprint('203.0.113.7', 'b'.repeat(64)));
});

test('domains are separated so identical strings do not collide', () => {
  // An IP and a user agent that happened to be the same string must not be
  // indistinguishable in the ledger.
  assert.notEqual(fingerprint('ip', 'same', pepper), fingerprint('ua', 'same', pepper));
});

test('a missing address still produces a digest', () => {
  // The column is queried with equality; a null here would silently drop the
  // row from every source-based rule.
  assert.equal(ipFingerprint(undefined, pepper).length, 64);
  assert.equal(ipFingerprint('', pepper), ipFingerprint(undefined, pepper));
});

test('a missing user agent is null rather than a digest of nothing', () => {
  assert.equal(userAgentFingerprint(undefined, pepper), null);
  assert.equal(userAgentFingerprint('', pepper), null);
});

test('an oversized user agent is bounded before hashing', () => {
  const long = 'x'.repeat(5000);
  assert.equal(userAgentFingerprint(long, pepper), userAgentFingerprint('x'.repeat(500), pepper));
});

test('email fingerprints match the case-insensitive lookup used in auth', () => {
  // auth.ts compares on lower(email); the fingerprint must agree or the two
  // views of "the same address" diverge.
  assert.equal(emailFingerprint('  User@Example.COM ', pepper), emailFingerprint('user@example.com', pepper));
});

test('digests are fixed-length hex, matching the char(64) column', () => {
  assert.match(emailFingerprint('user@example.com', pepper), /^[0-9a-f]{64}$/);
});
