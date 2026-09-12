/**
 * Password policy, aligned with NIST SP 800-63B section 5.1.1.2 and
 * ASVS 2.1.x (threat model F-04).
 *
 * The deliberate omissions matter as much as the rules:
 *
 *   - No composition requirement (uppercase / digit / symbol).  Both NIST and
 *     ASVS 2.1.3 advise against it: it measurably pushes users toward
 *     `Password1!` while adding almost no search-space cost to an attacker.
 *   - No maximum age / forced rotation, for the same reason.
 *   - No truncation and no character-class restriction: the full Unicode range
 *     is accepted, so passphrases and non-Latin scripts work.
 *
 * What replaces them is length, a blocklist, and the breach check in
 * pwned-passwords.ts.  Every function here is pure so that the rules can be
 * tested exhaustively without a database or a network.
 */

export type PasswordRejection = {
  code:
    | 'PASSWORD_TOO_SHORT'
    | 'PASSWORD_TOO_LONG'
    | 'PASSWORD_TOO_COMMON'
    | 'PASSWORD_REPEATS_CHARACTER'
    | 'PASSWORD_IS_SEQUENCE'
    | 'PASSWORD_CONTAINS_PERSONAL_DATA'
    | 'PASSWORD_CONTAINS_SERVICE_NAME';
  message: string;
};

export type PasswordContext = {
  email?: string;
  displayName?: string;
};

export const passwordMaxLength = 256;
export const passwordAbsoluteMinLength = 12;

/**
 * A small local blocklist.  It is not meant to be complete -- the Have I Been
 * Pwned range API is the authoritative check -- but it rejects the worst
 * guesses without a network round trip, and it still applies when the breach
 * service is unavailable and the check fails open.
 */
const blockedPasswords = new Set([
  '123456', '12345678', '123456789', '1234567890', '111111', '000000',
  'password', 'password1', 'password123', 'passw0rd', 'p@ssword', 'p@ssw0rd',
  'qwerty', 'qwertyuiop', 'qwerty123', 'asdfghjkl', 'zxcvbnm',
  'iloveyou', 'admin', 'administrator', 'welcome', 'welcome1', 'letmein',
  'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball',
  'abc123', 'abcd1234', 'a1b2c3d4', 'trustno1', 'changeme', 'secret',
  'master', 'superman', 'starwars', 'whatever', 'freedom', 'shadow',
  'michael', 'jennifer', 'jordan23', 'hello123', 'test1234', 'temp1234',
  'colearnx', 'colearnx123', 'learning', 'student', 'teacher',
  'woaini1314', 'wangyifan', 'zhangwei', '5201314', '1qaz2wsx', 'qazwsxedc',
]);

const serviceTerms = ['colearnx', 'co-learn', 'colearn'];

/**
 * Leetspeak substitutions, applied before the blocklist comparison.
 *
 * Without this the list is trivially bypassed: `P@ssw0rd` is not `password`
 * to a set lookup, but it is the same password to an attacker's cracking
 * rules, which have applied these mappings since the 1990s.
 */
const symbolLeet: Record<string, string> = { '@': 'a', '!': 'i', '|': 'i', '$': 's', '+': 't' };
const digitLeet: Record<string, string> = {
  '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b',
};

/**
 * Unicode normalisation before every comparison.  Without it the same visual
 * password typed on two keyboards produces two different byte strings, and a
 * blocklist entry can be trivially bypassed with a compatibility character.
 * NFKC is the form NIST names for this purpose.
 */
export const normalisePassword = (password: string) => password.normalize('NFKC');

/** Longest run of one repeated character, e.g. `aaaa` returns 4. */
export function longestRepeat(value: string): number {
  let best = value.length > 0 ? 1 : 0;
  let run = 1;
  for (let index = 1; index < value.length; index += 1) {
    run = value[index] === value[index - 1] ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

/**
 * Longest ascending or descending run of adjacent code points, e.g.
 * `abcdef` and `987654` both return 6.  Catches keyboard-walk-adjacent
 * passwords that pass a length check.
 */
export function longestSequence(value: string): number {
  let best = value.length > 0 ? 1 : 0;
  let ascending = 1;
  let descending = 1;
  for (let index = 1; index < value.length; index += 1) {
    const delta = value.charCodeAt(index) - value.charCodeAt(index - 1);
    ascending = delta === 1 ? ascending + 1 : 1;
    descending = delta === -1 ? descending + 1 : 1;
    best = Math.max(best, ascending, descending);
  }
  return best;
}

/**
 * Tokens from the user's own identity that must not appear in the password.
 * Short tokens are dropped: rejecting every password containing `li` would be
 * hostile to the many users whose name is two characters.
 */
export function personalTokens(context: PasswordContext): string[] {
  const raw: string[] = [];
  if (context.email) raw.push(context.email.split('@')[0] ?? '');
  if (context.displayName) raw.push(...context.displayName.split(/[\s._-]+/));
  return raw
    .map((token) => token.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter((token) => token.length >= 4);
}

/**
 * Every base word an attacker's rule set would recover from this password.
 *
 * This is what makes the blocklist useful at all above the minimum length.
 * `password` is eight characters and can never reach the list on its own once
 * the minimum is twelve -- the length check fires first -- so every entry
 * would be dead code. What users actually type is `P@ssw0rd123!`, and that
 * must reduce to `password`.
 *
 * A single reduction cannot do this, because the transformations conflict:
 * `!` is a leet `i` in `h!ghway` and pure decoration in `P@ssw0rd!`, and
 * whichever the reducer assumes, the other case escapes. Real cracking tools
 * resolve this by applying several rules and testing every result, so that is
 * what happens here. A handful of candidates is cheap and each is compared
 * whole, never as a substring, so `masterclass` is never rejected for
 * containing `master`.
 */
export function reductionCandidates(password: string): string[] {
  const folded = normalisePassword(password).toLowerCase();
  const symbolMapped = [...folded].map((character) => symbolLeet[character] ?? character).join('');
  const stripPadding = (value: string) => value.replace(/^[0-9]+/, '').replace(/[0-9]+$/, '');
  const deleetDigits = (value: string) => [...value].map((character) => digitLeet[character] ?? character).join('');
  const alphanumeric = folded.replace(/[^a-z0-9]/g, '');
  const symbolAlphanumeric = symbolMapped.replace(/[^a-z0-9]/g, '');
  // Trailing `!!!` is decoration; an interior `!` is a leet `i`. Trimming the
  // edges before mapping lets one candidate treat each the way a cracking rule
  // would, which the untrimmed candidate above cannot do simultaneously.
  const edgeTrimmed = folded.replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '');
  const trimmedSymbolMapped = [...edgeTrimmed]
    .map((character) => symbolLeet[character] ?? character)
    .join('')
    .replace(/[^a-z0-9]/g, '');

  return [
    folded,
    // Decoration removed, digits left alone: catches keyboard walks that are
    // themselves listed, such as 1qaz2wsx.
    alphanumeric,
    // Padding digits removed, then interior leet digits resolved: the common
    // `Passw0rd2026` shape.
    deleetDigits(stripPadding(alphanumeric)),
    // No padding assumption, in case the digits are part of the word.
    deleetDigits(alphanumeric),
    // Symbols resolved as letters first: the `p@ssword` shape, where stripping
    // the symbol instead would destroy the word.
    deleetDigits(stripPadding(symbolAlphanumeric)),
    // Edge decoration dropped, interior symbols read as letters: the
    // `P@ssw0rd123!` shape, which every other candidate misses.
    deleetDigits(stripPadding(trimmedSymbolMapped)),
  ];
}

export function evaluatePassword(
  rawPassword: string,
  context: PasswordContext = {},
  minLength: number = passwordAbsoluteMinLength,
): PasswordRejection | null {
  const password = normalisePassword(rawPassword);
  // Counted in code points, not UTF-16 units, so an emoji or a CJK character
  // counts as one character rather than two.
  const length = [...password].length;

  if (length < minLength) {
    return { code: 'PASSWORD_TOO_SHORT', message: `Use at least ${minLength} characters.` };
  }
  if (length > passwordMaxLength) {
    return { code: 'PASSWORD_TOO_LONG', message: `Use at most ${passwordMaxLength} characters.` };
  }

  const folded = password.toLowerCase();

  const candidates = reductionCandidates(password);
  // A candidate is only trusted when enough of the password survives
  // reduction: a five-character core is a real word, whereas a two-character
  // one is an artefact of stripping and would cause false rejections.
  if (candidates.some((candidate) => candidate.length >= 5 && blockedPasswords.has(candidate))) {
    return { code: 'PASSWORD_TOO_COMMON', message: 'This password appears on common-password lists. Choose another.' };
  }
  if (longestRepeat(folded) >= 4) {
    return { code: 'PASSWORD_REPEATS_CHARACTER', message: 'Avoid repeating the same character four or more times.' };
  }
  if (longestSequence(folded) >= 6) {
    return { code: 'PASSWORD_IS_SEQUENCE', message: 'Avoid long runs of consecutive characters such as abcdef or 123456.' };
  }
  if (serviceTerms.some((term) => candidates.some((candidate) => candidate.includes(term.replace('-', ''))))) {
    return { code: 'PASSWORD_CONTAINS_SERVICE_NAME', message: 'Do not include the service name in your password.' };
  }
  const alphanumeric = folded.replace(/[^a-z0-9]/g, '');
  if (personalTokens(context).some((token) => alphanumeric.includes(token))) {
    return { code: 'PASSWORD_CONTAINS_PERSONAL_DATA', message: 'Do not base your password on your name or email address.' };
  }
  return null;
}
