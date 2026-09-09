import assert from "node:assert/strict";
import test from "node:test";
import { createTopUpPackageLoader } from "./topUpPackages.js";

const packages = [{ id: "package-5", displayName: "S$5 = 5 points", amountMinor: 500, points: 5 }];
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("package loading ends with ready data", async () => {
  const states = [];
  const loader = createTopUpPackageLoader(async () => packages, (state) => states.push(state));
  await loader.load();
  assert.deepEqual(states.map((state) => state.status), ["loading", "ready"]);
  assert.deepEqual(states.at(-1).packages, packages);
});

test("a failed or timed-out load can recover by retrying without a page reload", async () => {
  const states = [];
  let attempts = 0;
  const loader = createTopUpPackageLoader(async () => {
    if (++attempts === 1) throw new Error("timeout of 12000ms exceeded");
    return packages;
  }, (state) => states.push(state));
  await loader.load();
  assert.equal(states.at(-1).status, "error");
  assert.match(states.at(-1).error, /Unable to load/);
  await loader.load();
  assert.deepEqual(states.map((state) => state.status), ["loading", "error", "loading", "ready"]);
  assert.equal(states.at(-1).error, "");
});

test("a successful empty response is empty, not permanently loading", async () => {
  const states = [];
  const loader = createTopUpPackageLoader(async () => [], (state) => states.push(state));
  await loader.load();
  assert.equal(states.at(-1).status, "empty");
  assert.deepEqual(states.at(-1).packages, []);
});

test("malformed package data produces a retryable error", async () => {
  for (const invalid of [null, {}, "packages", [null], [{}], [{ ...packages[0], amountMinor: "500" }]]) {
    let state;
    const loader = createTopUpPackageLoader(async () => invalid, (next) => { state = next; });
    await loader.load();
    assert.equal(state.status, "error");
    assert.deepEqual(state.packages, []);
  }
});

test("retry cancels the prior request and ignores its late successful response", async () => {
  const first = deferred();
  const states = [];
  const signals = [];
  const loader = createTopUpPackageLoader(({ signal }) => {
    signals.push(signal);
    return signals.length === 1 ? first.promise : Promise.resolve(packages);
  }, (state) => states.push(state));
  const oldRequest = loader.load();
  await loader.load();
  assert.equal(signals[0].aborted, true);
  first.resolve([]);
  await oldRequest;
  assert.deepEqual(states.map((state) => state.status), ["loading", "loading", "ready"]);
  assert.deepEqual(states.at(-1).packages, packages);
});

test("closing the modal cancels its request without publishing an error", async () => {
  const pending = deferred();
  const states = [];
  let signal;
  const loader = createTopUpPackageLoader((options) => {
    signal = options.signal;
    return pending.promise;
  }, (state) => states.push(state));
  const request = loader.load();
  loader.cancel();
  pending.reject(new Error("request cancelled"));
  await request;
  assert.equal(signal.aborted, true);
  assert.deepEqual(states.map((state) => state.status), ["loading"]);
});

test("loading again after cleanup works in StrictMode and on a fresh modal", async () => {
  const pending = deferred();
  let calls = 0;
  const states = [];
  const loader = createTopUpPackageLoader(() => ++calls === 1 ? pending.promise : Promise.resolve(packages), (state) => states.push(state));
  const original = loader.load();
  loader.cancel();
  await loader.load();
  pending.reject(new Error("late failure"));
  await original;
  assert.deepEqual(states.map((state) => state.status), ["loading", "loading", "ready"]);
});
