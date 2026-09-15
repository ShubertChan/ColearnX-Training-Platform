import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { decryptSecret, deriveMfaKey, encryptSecret } from './secret-store.js';

const key = deriveMfaKey('a'.repeat(48));
const other = deriveMfaKey('b'.repeat(48));

test('a secret round-trips under its own key', () => {
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  assert.equal(decryptSecret(encryptSecret(secret, key), key), secret);
});

test('the same plaintext never produces the same ciphertext', () => {
  // A fresh nonce every time. Equal ciphertexts would reveal which accounts
  // share a secret, and nonce reuse breaks GCM outright.
  const a = encryptSecret('JBSWY3DPEHPK3PXP', key);
  const b = encryptSecret('JBSWY3DPEHPK3PXP', key);
  assert.notEqual(a, b);
  assert.notEqual(a.split('.')[0], b.split('.')[0]);
});

test('a different key cannot decrypt', () => {
  assert.throws(() => decryptSecret(encryptSecret('JBSWY3DPEHPK3PXP', key), other));
});

test('tampering with the ciphertext fails loudly instead of yielding a wrong secret', () => {
  // The reason for GCM over CBC: a silently wrong secret would lock the user
  // out with no diagnosis.
  const stored = encryptSecret('JBSWY3DPEHPK3PXP', key);
  const [nonce, ciphertext, tag] = stored.split('.');
  const flipped = Buffer.from(ciphertext, 'base64url');
  flipped[0] ^= 1;
  assert.throws(() => decryptSecret(`${nonce}.${flipped.toString('base64url')}.${tag}`, key));
});

test('tampering with the tag fails', () => {
  const stored = encryptSecret('JBSWY3DPEHPK3PXP', key);
  const [nonce, ciphertext, tag] = stored.split('.');
  const flipped = Buffer.from(tag, 'base64url');
  flipped[0] ^= 1;
  assert.throws(() => decryptSecret(`${nonce}.${ciphertext}.${flipped.toString('base64url')}`, key));
});

test('malformed stored values are rejected without throwing something unhelpful', () => {
  for (const bad of ['', 'x', 'a.b', 'a.b.c.d', 'AAAA.BBBB.CCCC']) {
    assert.throws(() => decryptSecret(bad, key));
  }
});

test('the derived key is 32 bytes and domain separated', () => {
  assert.equal(key.length, 32);
  const naive = createHash('sha256').update('a'.repeat(48)).digest();
  assert.notDeepEqual(key, naive);
});
