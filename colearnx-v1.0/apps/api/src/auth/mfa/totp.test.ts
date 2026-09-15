import assert from 'node:assert/strict';
import test from 'node:test';
import {
  base32Decode, base32Encode, generateTotpSecret, otpauthUri,
  totpCodeForStep, totpPeriodSeconds, totpStep, verifyTotp,
} from './totp.js';

// RFC 6238 appendix B uses the ASCII secret "12345678901234567890".
const rfcSecret = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

test('matches the RFC 6238 appendix B test vectors', () => {
  // The whole reason this is implemented in-repo rather than taken on trust
  // from a package: correctness is demonstrated, not assumed.
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [seconds, expected] of vectors) {
    const step = Math.floor(seconds / totpPeriodSeconds);
    assert.equal(totpCodeForStep(rfcSecret, step, 8), expected, `T=${seconds}`);
  }
});

test('base32 round-trips arbitrary bytes', () => {
  for (const length of [1, 2, 5, 10, 20, 32]) {
    const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 37) % 256));
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  }
});

test('base32 tolerates what users actually paste', () => {
  // Authenticator apps and password managers display secrets in spaced,
  // lower-case, sometimes padded form. Rejecting those is a support burden
  // with no security benefit.
  const canonical = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
  const messy = `${canonical.toLowerCase().match(/.{1,4}/g)!.join(' ')}===`;
  assert.deepEqual(base32Decode(messy), base32Decode(canonical));
});

test('an invalid character is rejected rather than silently skipped', () => {
  // Skipping would make two different secrets decode identically.
  assert.throws(() => base32Decode('ABC1DEF'), /Invalid base32/);
});

test('generated secrets carry 160 bits', () => {
  assert.equal(base32Decode(generateTotpSecret()).length, 20);
  assert.notEqual(generateTotpSecret(), generateTotpSecret());
});

test('a current code verifies and reports its step', () => {
  const now = 1_700_000_000_000;
  const code = totpCodeForStep(rfcSecret, totpStep(now));
  const result = verifyTotp(rfcSecret, code, now, null);
  assert.equal(result.valid, true);
  assert.equal(result.valid && result.step, totpStep(now));
});

test('one step of clock drift is accepted in each direction', () => {
  const now = 1_700_000_000_000;
  for (const offset of [-1, 0, 1]) {
    const code = totpCodeForStep(rfcSecret, totpStep(now) + offset);
    assert.equal(verifyTotp(rfcSecret, code, now, null).valid, true, `offset ${offset}`);
  }
});

test('two steps of drift are not accepted', () => {
  // The window is a guessing surface multiplier, so it stays narrow.
  const now = 1_700_000_000_000;
  for (const offset of [-2, 2]) {
    const code = totpCodeForStep(rfcSecret, totpStep(now) + offset);
    assert.equal(verifyTotp(rfcSecret, code, now, null).valid, false, `offset ${offset}`);
  }
});

test('a code cannot be replayed once its step has been used', () => {
  // Without this an observed code stays usable for its whole window.
  const now = 1_700_000_000_000;
  const step = totpStep(now);
  const code = totpCodeForStep(rfcSecret, step);
  assert.equal(verifyTotp(rfcSecret, code, now, null).valid, true);
  assert.equal(verifyTotp(rfcSecret, code, now, step).valid, false);
});

test('replay protection does not block the next step', () => {
  const now = 1_700_000_000_000;
  const step = totpStep(now);
  const next = totpCodeForStep(rfcSecret, step + 1);
  assert.equal(verifyTotp(rfcSecret, next, now, step).valid, true);
});

test('malformed submissions are rejected before any HMAC work', () => {
  const now = 1_700_000_000_000;
  for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', '１２３４５６']) {
    assert.equal(verifyTotp(rfcSecret, bad, now, null).valid, false, bad);
  }
});

test('spaces inside a six digit code are tolerated', () => {
  const now = 1_700_000_000_000;
  const code = totpCodeForStep(rfcSecret, totpStep(now));
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  assert.equal(verifyTotp(rfcSecret, spaced, now, null).valid, true);
});

test('the otpauth URI carries what authenticator apps need', () => {
  const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'user@example.com');
  assert.match(uri, /^otpauth:\/\/totp\/CoLearnX:user%40example\.com\?/);
  assert.match(uri, /secret=JBSWY3DPEHPK3PXP/);
  assert.match(uri, /algorithm=SHA1/);
  assert.match(uri, /digits=6/);
  assert.match(uri, /period=30/);
});
