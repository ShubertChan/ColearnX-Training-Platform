import test from "node:test";
import assert from "node:assert/strict";
import { readSessionResource, SESSION_READ_TIMEOUT_MS } from "./sessionRecovery.js";

const failure = (status, code = "NETWORK_ERROR") => Object.assign(new Error("unavailable"), { status, code });

test("session GETs tolerate a cold start with bounded timeout and backoff", async () => {
  const timeouts = [], delays = []; let calls = 0;
  const user = await readSessionResource(async (options) => {
    timeouts.push(options.timeout);
    if (++calls < 4) throw failure(calls === 1 ? 0 : 503);
    return { id: "confirmed" };
  }, { wait: async (ms) => { delays.push(ms); } });
  assert.deepEqual(user, { id: "confirmed" });
  assert.deepEqual(delays, [1000, 2000, 4000]);
  assert.deepEqual(timeouts, Array(4).fill(SESSION_READ_TIMEOUT_MS));
  assert.equal(SESSION_READ_TIMEOUT_MS * calls + delays.reduce((a, b) => a + b, 0), 87000);
});

test("persistent network failure stops after four GET attempts", async () => {
  let calls = 0;
  await assert.rejects(readSessionResource(async () => { calls++; throw failure(0); }, { wait: async () => {} }));
  assert.equal(calls, 4);
});

for (const [status, code] of [[401, "AUTH_REQUIRED"], [403, "DENIED"], [404, "NOT_FOUND"], [429, "RATE_LIMITED"], [0, "ERR_CANCELED"], [401, "SESSION_CHANGED"]]) {
  test(`session ${code} is not hidden by a retry loop`, async () => {
    let calls = 0;
    await assert.rejects(readSessionResource(async () => { calls++; throw failure(status, code); }));
    assert.equal(calls, 1);
  });
}

test("cancelling during backoff prevents the next request", async () => {
  const controller = new AbortController(); let calls = 0;
  const recovery = readSessionResource(async () => { calls++; throw failure(503); }, { signal: controller.signal });
  const rejected = assert.rejects(recovery, (error) => error.code === "ERR_CANCELED");
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(); await rejected;
  assert.equal(calls, 1);
});

test("an already cancelled recovery sends no request", async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(readSessionResource(async () => { calls++; }, { signal: controller.signal }), (error) => error.code === "ERR_CANCELED");
  assert.equal(calls, 0);
});
