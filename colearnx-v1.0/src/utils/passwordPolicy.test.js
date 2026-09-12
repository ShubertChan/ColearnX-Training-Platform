import assert from "node:assert/strict";
import test from "node:test";
import {
  PASSWORD_MIN_LENGTH,
  passwordChecklist,
  passwordChecklistPasses,
  passwordLength,
  passwordStrength,
  personalTokens,
} from "./passwordPolicy.js";

const failing = (password, context) =>
  passwordChecklist(password, context)
    .filter((item) => !item.passed)
    .map((item) => item.id);

test("the client minimum matches the server minimum", () => {
  // If these ever diverge the screen lies to the user. The server value lives
  // in apps/api/src/auth/password-policy.ts (passwordAbsoluteMinLength).
  assert.equal(PASSWORD_MIN_LENGTH, 12);
});

test("a passphrase with no digits or capitals is accepted", () => {
  // The regression this file exists to prevent: the previous screen demanded
  // upper-case, lower-case and a digit, which ASVS 2.1.3 advises against and
  // which rejected every passphrase.
  assert.deepEqual(failing("correct horse battery staple"), []);
});

test("length is counted in code points", () => {
  assert.equal(passwordLength("学习平台安全防护建设方案"), 12);
  assert.deepEqual(failing("学习平台安全防护建设方案"), []);
  assert.deepEqual(failing("学习平台安全"), ["length"]);
});

test("every failing rule is reported at once, not just the first", () => {
  // Reporting one at a time is how users end up appending characters until
  // something sticks.
  assert.deepEqual(failing("aaaa", { displayName: "Test" }).sort(), ["length", "repeat"]);
});

test("repeats and sequences are caught at the same thresholds as the server", () => {
  assert.deepEqual(failing("treeeemarble7x"), ["repeat"]);
  assert.deepEqual(failing("treeemarble7xy"), []);
  assert.deepEqual(failing("marbleabcdefxy"), ["sequence"]);
  assert.deepEqual(failing("marble987654xy"), ["sequence"]);
});

test("personal data and the service name are caught", () => {
  assert.deepEqual(failing("Zhang.Wei!2026x", { displayName: "Zhang Wei" }), ["personal"]);
  assert.deepEqual(failing("colearnx-vessel"), ["service"]);
});

test("short identity tokens are not treated as personal data", () => {
  assert.deepEqual(personalTokens({ displayName: "Li Na" }), []);
  assert.deepEqual(failing("marble-li-vessel", { displayName: "Li Na" }), []);
});

test("the client never rejects something the server would accept", () => {
  // The drift rule. These all clear the server policy, so the screen must not
  // block them -- a client stricter than the server fails silently.
  const serverAcceptable = [
    "correct horse battery staple",
    "marble-tundra-vessel-07",
    "  marble tundra vessel  ",
    "学习平台安全防护建设方案",
    "MasterClass2026x",
  ];
  for (const password of serverAcceptable) {
    assert.ok(passwordChecklistPasses(password), `client rejected: ${password}`);
  }
});

test("the strength band is advisory and never claims an entropy figure", () => {
  assert.equal(passwordStrength("").band, 0);
  assert.equal(passwordStrength("short").band, 1);
  assert.equal(passwordStrength("marble tundra").band, 2);
  assert.equal(passwordStrength("marble tundra vessel").band, 4);
  // Length drives the band; symbols do not buy a higher one.
  assert.ok(passwordStrength("marble!!tundra").band < passwordStrength("marble tundra vessel").band);
});
