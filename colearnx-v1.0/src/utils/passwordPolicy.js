/**
 * Client-side mirror of the server password policy.
 *
 * AUTHORITY: none. apps/api/src/auth/password-policy.ts is the only thing that
 * decides whether a password is acceptable. This file exists so the user finds
 * out before submitting, not so the browser gets a vote -- anything here can be
 * edited by whoever is running the browser.
 *
 * DRIFT RULE: these checks are deliberately a strict SUBSET of the server's.
 * The blocklist, its leetspeak reduction and the breach lookup are not
 * reproduced -- the first two would ship a dictionary of bad passwords into
 * every client bundle for no gain, and the third belongs on the server.
 *
 * A subset is the safe direction to drift. The client may accept something the
 * server then rejects, which costs one round trip and shows a clear message.
 * The reverse -- a client stricter than the server -- would silently block
 * passwords that are perfectly valid, and nobody would ever see it in a log.
 * The previous version of this screen did exactly that: it demanded an
 * upper-case letter, a lower-case letter and a digit, which both NIST
 * SP 800-63B and ASVS 2.1.3 advise against, and which rejected every
 * passphrase.
 */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

const SERVICE_TERMS = ["colearnx", "colearn"];

/** Matches the server: NFKC, so the two count the same characters. */
export const normalisePassword = (password) =>
  typeof password === "string" ? password.normalize("NFKC") : "";

/** Code points, not UTF-16 units, so one CJK character counts as one. */
export const passwordLength = (password) => [...normalisePassword(password)].length;

export function longestRepeat(value) {
  let best = value.length > 0 ? 1 : 0;
  let run = 1;
  for (let index = 1; index < value.length; index += 1) {
    run = value[index] === value[index - 1] ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

export function longestSequence(value) {
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

export function personalTokens({ email = "", displayName = "" } = {}) {
  const raw = [];
  if (email) raw.push(email.split("@")[0] ?? "");
  if (displayName) raw.push(...displayName.split(/[\s._-]+/));
  return raw
    .map((token) => token.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((token) => token.length >= 4);
}

/**
 * The checklist rendered next to the field.
 *
 * Returned as data rather than as a single pass/fail string so the UI can show
 * every requirement up front. A user who is told only the first thing wrong
 * has to submit repeatedly to discover the rest, which is how people end up
 * appending `1!` to a word until something is accepted.
 */
export function passwordChecklist(password, context = {}) {
  const value = normalisePassword(password);
  const folded = value.toLowerCase();
  const alphanumeric = folded.replace(/[^a-z0-9]/g, "");
  const length = passwordLength(password);

  return [
    {
      id: "length",
      label: `At least ${PASSWORD_MIN_LENGTH} characters`,
      passed: length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH,
    },
    {
      id: "repeat",
      label: "No character repeated four times or more",
      passed: longestRepeat(folded) < 4,
    },
    {
      id: "sequence",
      label: "No long runs such as abcdef or 123456",
      passed: longestSequence(folded) < 6,
    },
    {
      id: "personal",
      label: "Not based on your name or email address",
      passed: !personalTokens(context).some((token) => alphanumeric.includes(token)),
    },
    {
      id: "service",
      label: "Does not contain the service name",
      passed: !SERVICE_TERMS.some((term) => folded.includes(term)),
    },
  ];
}

export const passwordChecklistPasses = (password, context) =>
  passwordChecklist(password, context).every((item) => item.passed);

/**
 * A coarse four-band indicator, driven mostly by length.
 *
 * This is NOT an entropy estimate and is not labelled as one. A real estimate
 * needs the dictionary and pattern matching that zxcvbn carries, and shipping
 * a confident-looking "128 bits" number computed from character classes is
 * worse than showing nothing: it tells users `P@ssw0rd1` is strong.
 *
 * Length dominates because, for a password that has already cleared the
 * checklist, length is the only thing here that reliably tracks guessing cost.
 */
export function passwordStrength(password, context = {}) {
  const length = passwordLength(password);
  if (length === 0) return { band: 0, label: "" };
  if (!passwordChecklistPasses(password, context)) {
    return { band: 1, label: "Does not meet the requirements yet" };
  }
  if (length >= 20) return { band: 4, label: "Strong" };
  if (length >= 16) return { band: 3, label: "Good" };
  return { band: 2, label: "Acceptable — longer is better than more symbols" };
}
