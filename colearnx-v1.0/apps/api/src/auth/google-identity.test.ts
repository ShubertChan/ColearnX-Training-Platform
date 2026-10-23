import assert from 'node:assert/strict';
import test from 'node:test';
import type { TokenPayload } from 'google-auth-library';
import { googleIdentity } from './google-identity.js';

const claims = {
  sub: 'google-subject', email: 'Member@Gmail.com', email_verified: true, name: ' Member ',
  nonce: 'x'.repeat(64), exp: Math.floor(Date.now() / 1000) + 600,
  iat: Math.floor(Date.now() / 1000), aud: 'client', iss: 'https://accounts.google.com',
};
test('verified Google claims normalize email but never strip dots or plus aliases', () => {
  assert.deepEqual(googleIdentity(claims), { subject: 'google-subject', email: 'member@gmail.com', name: 'Member', nonce: claims.nonce });
  assert.equal(googleIdentity({ ...claims, email: 'first.last+course@gmail.com' }).email, 'first.last+course@gmail.com');
  assert.equal(googleIdentity({ ...claims, email: 'employee@company.test', hd: 'company.test' }).email, 'employee@company.test');
});
test('third-party Google mailboxes cannot silently claim existing local accounts', () => {
  assert.throws(() => googleIdentity({ ...claims, email: 'member@outlook.com' }), { code: 'GOOGLE_EMAIL_NOT_AUTHORITATIVE' });
});
test('missing, unverified, expired and nonce-free identities are rejected', () => {
  for (const replacement of [{ sub: '' }, { email: 'bad' }, { email_verified: false }, { email_verified: 'true' },
    { exp: 1 }, { iat: Math.floor(Date.now() / 1000) + 600 }, { nonce: undefined }, { nonce: 'short' }]) {
    assert.throws(() => googleIdentity({ ...claims, ...replacement } as TokenPayload), { code: 'GOOGLE_CREDENTIAL_INVALID' });
  }
  assert.throws(() => googleIdentity(undefined), { code: 'GOOGLE_CREDENTIAL_INVALID' });
});
