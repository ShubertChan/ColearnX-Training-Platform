import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatRecoveryCode, generateRecoveryCode, generateRecoveryCodes,
  hashRecoveryCode, normaliseRecoveryCode, recoveryCodeCount, recoveryCodeMatches,
} from './recovery-codes.js';

const pepper = 'p'.repeat(64);

test('a full set is issued and every code is distinct', () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, recoveryCodeCount);
  assert.equal(new Set(codes).size, recoveryCodeCount);
});

test('codes carry enough entropy to be stored as a keyed digest', () => {
  // 20 characters from a 32-symbol alphabet is 100 bits. That is why argon2 is
  // not used here -- there is nothing to slow down.
  const code = generateRecoveryCode();
  assert.equal(code.length, 20);
  assert.equal(Math.round(20 * Math.log2(32)), 100);
});

test('visually ambiguous characters are excluded', () => {
  // These get written on paper and typed back months later.
  const sample = generateRecoveryCodes().join('');
  assert.doesNotMatch(sample, /[I1O0]/);
});

test('display grouping does not change the value', () => {
  const code = generateRecoveryCode();
  assert.equal(formatRecoveryCode(code), `${code.slice(0,5)}-${code.slice(5,10)}-${code.slice(10,15)}-${code.slice(15,20)}`);
  assert.equal(normaliseRecoveryCode(formatRecoveryCode(code)), code);
});

test('the user may type the code back in any reasonable form', () => {
  const code = generateRecoveryCode();
  const stored = hashRecoveryCode(code, pepper);
  for (const variant of [code, code.toLowerCase(), formatRecoveryCode(code), `  ${formatRecoveryCode(code).toLowerCase()}  `]) {
    assert.ok(recoveryCodeMatches(variant, stored, pepper), variant);
  }
});

test('a different code does not match', () => {
  const stored = hashRecoveryCode(generateRecoveryCode(), pepper);
  assert.equal(recoveryCodeMatches(generateRecoveryCode(), stored, pepper), false);
});

test('a different pepper does not match', () => {
  const code = generateRecoveryCode();
  assert.equal(recoveryCodeMatches(code, hashRecoveryCode(code, pepper), 'q'.repeat(64)), false);
});

test('a malformed stored digest is rejected rather than throwing', () => {
  // timingSafeEqual throws on length mismatch; the guard must catch that.
  assert.equal(recoveryCodeMatches(generateRecoveryCode(), 'short', pepper), false);
  assert.equal(recoveryCodeMatches(generateRecoveryCode(), '', pepper), false);
});

test('empty input never matches anything', () => {
  const code = generateRecoveryCode();
  assert.equal(recoveryCodeMatches('', hashRecoveryCode(code, pepper), pepper), false);
});
