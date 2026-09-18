import test from "node:test";
import assert from "node:assert/strict";
import { readSessionValue, writeSessionValue, sessionStorageUnavailable, subscribeSessionStorage } from "./sessionStorage.js";
test("blocked storage reads, writes and removal degrade without throwing", () => {
  const previous = globalThis.window; let notices = 0;
  const unsubscribe = subscribeSessionStorage(() => notices++);
  try {
    globalThis.window = { get sessionStorage() { throw new DOMException("Blocked", "SecurityError"); } };
    assert.equal(readSessionValue("token"), "");
    assert.doesNotThrow(() => writeSessionValue("token", "value"));
    assert.doesNotThrow(() => writeSessionValue("token", ""));
    assert.equal(sessionStorageUnavailable(), true); assert.ok(notices > 0);
  } finally { unsubscribe(); if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});
