import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// W5 (ASVS 5.3.3): confirm the client relies on React's default output
// encoding and never opts a value out of it. Built by concatenation so this
// guard file does not match itself, and test files are skipped.
const NEEDLE = ["dangerously", "Set", "InnerHTML"].join("");
const srcRoot = fileURLToPath(new URL("../", import.meta.url)); // -> src/

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
      continue;
    }
    if (/\.test\.(jsx?|tsx?)$/.test(name)) continue;
    if (/\.(jsx?|tsx?)$/.test(name)) yield full;
  }
}

test("no component uses the raw-HTML escape hatch (XSS output encoding stays intact)", () => {
  const offenders = [];
  for (const file of sourceFiles(srcRoot)) {
    if (readFileSync(file, "utf8").includes(NEEDLE)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `${NEEDLE} found in: ${offenders.join(", ")}`);
});
