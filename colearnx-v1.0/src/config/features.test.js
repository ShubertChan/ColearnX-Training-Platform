import assert from "node:assert/strict";
import test from "node:test";
import { isFeatureEnabled } from "./features.js";

test("feature flags are disabled unless explicitly set to true", () => {
  assert.equal(isFeatureEnabled(undefined), false);
  assert.equal(isFeatureEnabled(""), false);
  assert.equal(isFeatureEnabled("false"), false);
  assert.equal(isFeatureEnabled("1"), false);
});

test("feature flags accept boolean true and case-insensitive true strings", () => {
  assert.equal(isFeatureEnabled(true), true);
  assert.equal(isFeatureEnabled("true"), true);
  assert.equal(isFeatureEnabled(" TRUE "), true);
});

test("feature flags preserve an explicit boolean false", () => {
  assert.equal(isFeatureEnabled(false), false);
});
