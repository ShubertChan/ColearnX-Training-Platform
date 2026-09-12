import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluatePassword,
  longestRepeat,
  longestSequence,
  normalisePassword,
  personalTokens,
  reductionCandidates,
} from './password-policy.js';

test('a long unique passphrase is accepted', () => {
  assert.equal(evaluatePassword('marble-tundra-vessel-07'), null);
});

test('length is measured in code points, not UTF-16 units', () => {
  // Twelve CJK characters are twelve characters, not twenty-four. Counting
  // UTF-16 units would let a six-character password through.
  assert.equal(evaluatePassword('学习平台安全防护建设方案')?.code ?? null, null);
  assert.equal(evaluatePassword('学习平台安全')?.code, 'PASSWORD_TOO_SHORT');
});

test('the minimum length is configurable and enforced', () => {
  assert.equal(evaluatePassword('short1234')?.code, 'PASSWORD_TOO_SHORT');
  assert.equal(evaluatePassword('twelvechars!', {}, 16)?.code, 'PASSWORD_TOO_SHORT');
});

test('common passwords are rejected regardless of case', () => {
  assert.equal(evaluatePassword('AdMiNiStRaToR')?.code, 'PASSWORD_TOO_COMMON');
});

test('a blocked word dressed up to pass the length check is still blocked', () => {
  // The case that matters in practice: nobody submits `password` once the
  // minimum is twelve, they submit this.
  assert.ok(reductionCandidates('P@ssw0rd123!').includes('password'));
  assert.equal(evaluatePassword('P@ssw0rd123!')?.code, 'PASSWORD_TOO_COMMON');
  assert.equal(evaluatePassword('p@ssword2026')?.code, 'PASSWORD_TOO_COMMON');
  // A listed keyboard walk with decoration appended.
  assert.equal(evaluatePassword('1qaz2wsx!!!!!')?.code, 'PASSWORD_TOO_COMMON');
});

test('reduction compares the whole word, never a substring', () => {
  // `master` is blocked; `masterclass` is a different word and must survive.
  assert.ok(reductionCandidates('MasterClass2026').includes('masterclass'));
  assert.equal(evaluatePassword('MasterClass2026'), null);
});

test('reduction does not reject a password whose core is too short to judge', () => {
  assert.equal(evaluatePassword('xy-92847362514-zw'), null);
});

test('compatibility characters cannot smuggle a blocked password past the list', () => {
  // Fullwidth latin normalises to ASCII under NFKC. Without normalisation this
  // is a different byte string and the blocklist misses it entirely.
  assert.equal(normalisePassword('ｐａｓｓｗｏｒｄ１２３４'), 'password1234');
  assert.equal(evaluatePassword('ｐａｓｓｗｏｒｄ１２３４')?.code, 'PASSWORD_TOO_COMMON');
});

test('repeated characters are rejected at four, allowed at three', () => {
  assert.equal(longestRepeat('aaab'), 3);
  assert.equal(longestRepeat('baaaa'), 4);
  assert.equal(evaluatePassword('treeeemarble7')?.code, 'PASSWORD_REPEATS_CHARACTER');
  assert.equal(evaluatePassword('treeemarble7x'), null);
});

test('long consecutive runs are rejected in both directions', () => {
  assert.equal(longestSequence('abcdef'), 6);
  assert.equal(longestSequence('987654'), 6);
  assert.equal(longestSequence('acegik'), 1);
  assert.equal(evaluatePassword('marbleabcdefx')?.code, 'PASSWORD_IS_SEQUENCE');
  assert.equal(evaluatePassword('marble987654x')?.code, 'PASSWORD_IS_SEQUENCE');
});

test('the service name cannot be the password', () => {
  assert.equal(evaluatePassword('colearnx-vessel')?.code, 'PASSWORD_CONTAINS_SERVICE_NAME');
});

test('personal data is rejected across punctuation and case', () => {
  const context = { email: 'zhangwei@example.com', displayName: 'Zhang Wei' };
  assert.equal(evaluatePassword('Zhang.Wei!2026x', context)?.code, 'PASSWORD_CONTAINS_PERSONAL_DATA');
  assert.equal(evaluatePassword('marble-tundra-vessel', context), null);
});

test('short identity tokens are not treated as personal data', () => {
  // Rejecting every password containing "li" would be hostile to the many
  // users whose name is two characters.
  assert.deepEqual(personalTokens({ displayName: 'Li Na', email: 'li@example.com' }), []);
  assert.equal(evaluatePassword('marble-li-vessel', { displayName: 'Li Na' }), null);
});

test('no composition rule is imposed', () => {
  // NIST SP 800-63B and ASVS 2.1.3: an all-lowercase passphrase is acceptable.
  assert.equal(evaluatePassword('correct horse battery staple'), null);
});

test('spaces and unicode are preserved rather than stripped', () => {
  assert.equal(evaluatePassword('  marble tundra vessel  '), null);
});
