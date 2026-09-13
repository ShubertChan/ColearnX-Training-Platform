import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Source-level route contract checks: keep anonymous entry on the existing
// login guard without changing shared catalogue URLs or authenticated access.
const appSource = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

test("the bare website entry redirects to login without a return-to loop", () => {
  assert.match(appSource, /<Route path="\/" element=\{<Navigate to="\/login" replace \/>\} \/>/);
});

test("unknown routes use the same login entry rather than the marketplace", () => {
  assert.match(appSource, /<Route path="\*" element=\{<Navigate to="\/login" replace \/>\} \/>/);
});

test("login keeps its session guard and catalogue sharing routes stay public", () => {
  assert.match(appSource, /path="\/login" element=\{<AnonymousOnly><AuthPage \/><\/AnonymousOnly>\}/);
  for (const path of ["courses", "courses/:id", "contents", "contents/:id"]) {
    assert.match(appSource, new RegExp(`path="/${path}"\\s+element=\\{\\s*<MarketplaceShell>`));
  }
});
