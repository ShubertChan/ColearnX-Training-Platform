import assert from 'node:assert/strict';
import test from 'node:test';
import { countForSuffix, rangeParts } from './pwned-range.js';

test('only five hex characters ever leave the process', () => {
  // The k-anonymity property this whole control rests on: the prefix is five
  // characters and the remaining 35 are compared locally.
  const { prefix, suffix } = rangeParts('password');
  assert.equal(prefix, '5BAA6');
  assert.equal(prefix.length, 5);
  assert.equal(suffix, '1E4C9B93F3F0682250B6CF8331B7EE68FD8');
  assert.equal(prefix + suffix, '5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8');
});

test('the digest is taken after NFKC normalisation', () => {
  // Must agree with the blocklist comparison in password-policy.ts, otherwise
  // the same password is judged two different ways by two controls.
  assert.deepEqual(rangeParts('ｐａｓｓｗｏｒｄ'), rangeParts('password'));
});

test('a matching suffix returns its breach count', () => {
  const body = '0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:9659365\r\n';
  assert.equal(countForSuffix(body, '1E4C9B93F3F0682250B6CF8331B7EE68FD8'), 9659365);
});

test('an absent suffix is not a breach', () => {
  const body = '0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n';
  assert.equal(countForSuffix(body, '1E4C9B93F3F0682250B6CF8331B7EE68FD8'), 0);
});

test('padding entries are counted as zero', () => {
  // Add-Padding injects synthetic suffixes with a count of 0. Treating one as
  // a hit would reject a perfectly good password.
  const body = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0\r\n';
  assert.equal(countForSuffix(body, 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'), 0);
});

test('malformed lines do not throw', () => {
  assert.equal(countForSuffix('garbage\r\n\r\nABC:notanumber\r\n', 'ABC'), 0);
  assert.equal(countForSuffix('', 'ABC'), 0);
});
