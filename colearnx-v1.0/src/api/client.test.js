import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { apiClient, setAccessToken, setCsrfToken, hasAccessToken, mutateApi } from "./client.js";

const originalAdapter = apiClient.defaults.adapter;
const response = (config, data = {}) => ({ config, status: 200, headers: {}, data: { data } });
function reject(config, status, code = "ACCESS_TOKEN_EXPIRED") {
  throw new axios.AxiosError("Rejected", "ERR_BAD_RESPONSE", config, null, { config, status, data: { error: { code, message: code } } });
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => { setAccessToken("old"); setCsrfToken("old-csrf"); });
afterEach(() => { apiClient.defaults.adapter = originalAdapter; setAccessToken(""); setCsrfToken(""); });

test("concurrent 401s share one refresh and preserve mutation keys and payloads", async () => {
  const calls = [], gate = deferred(); let refreshes = 0;
  apiClient.defaults.adapter = async config => {
    calls.push({ url: config.url, token: config.headers.Authorization, key: config.headers.get("Idempotency-Key"), data: config.data });
    if (config.url === "/auth/csrf") { assert.equal(config.headers.Authorization, undefined); return response(config, { csrfToken: "csrf" }); }
    if (config.url === "/auth/refresh") { refreshes++; await gate.promise; assert.equal(config.headers.Authorization, undefined); assert.equal(config.headers.get("X-CSRF-Token"), "csrf"); return response(config, { accessToken: "fresh", csrfToken: "rotated" }); }
    if (config.headers.Authorization === "Bearer old") reject(config, 401);
    assert.equal(config.headers.Authorization, "Bearer fresh");
    assert.equal(config.headers.get("X-CSRF-Token"), "rotated");
    return response(config);
  };
  const pending = Promise.all([apiClient.post("/courses/a/submit", { value: 1 }), apiClient.post("/courses/b/submit", { value: 2 })]);
  await new Promise(resolve => setImmediate(resolve)); gate.resolve(); await pending;
  assert.equal(refreshes, 1);
  for (const url of ["/courses/a/submit", "/courses/b/submit"]) {
    const requests = calls.filter(call => call.url === url);
    assert.equal(requests.length, 2); assert.ok(requests[0].key);
    assert.equal(requests[0].key, requests[1].key); assert.equal(requests[0].data, requests[1].data);
  }
});

test("a late 401 from the old token reuses the already refreshed token", async () => {
  const late = deferred(); let refreshes = 0;
  apiClient.defaults.adapter = async config => {
    if (config.url === "/auth/csrf") return response(config, { csrfToken: "csrf" });
    if (config.url === "/auth/refresh") { refreshes++; return response(config, { accessToken: "fresh", csrfToken: "csrf" }); }
    if (config.headers.Authorization === "Bearer old") { if (config.url === "/late") await late.promise; reject(config, 401); }
    return response(config);
  };
  const pending = apiClient.get("/late"); await apiClient.get("/early"); late.resolve(); await pending;
  assert.equal(refreshes, 1);
});

test("media expiry, permission failures and auth endpoints never trigger account refresh", async () => {
  const calls = [];
  apiClient.defaults.adapter = async config => { calls.push(config.url); reject(config, config.url === "/forbidden" ? 403 : 401, config.url === "/progress" ? "PLAYBACK_EXPIRED" : "DENIED"); };
  for (const url of ["/progress", "/forbidden", "/auth/login"]) await assert.rejects(apiClient.post(url));
  assert.deepEqual(calls, ["/progress", "/forbidden", "/auth/login"]);
});

test("a rejected refresh stops once and clears expired credentials", async () => {
  const calls = [];
  apiClient.defaults.adapter = async config => {
    calls.push(config.url);
    if (config.url === "/auth/csrf") return response(config, { csrfToken: "csrf" });
    reject(config, 401);
  };
  await assert.rejects(apiClient.get("/wallet"), error => error.status === 401);
  assert.deepEqual(calls, ["/wallet", "/auth/csrf", "/auth/refresh"]);
  assert.equal(hasAccessToken(), false);
});

test("a request rejected after successful refresh is not retried indefinitely", async () => {
  let requests = 0, refreshes = 0;
  apiClient.defaults.adapter = async config => {
    if (config.url === "/auth/csrf") return response(config, { csrfToken: "csrf" });
    if (config.url === "/auth/refresh") { refreshes++; return response(config, { accessToken: "fresh", csrfToken: "csrf" }); }
    requests++; reject(config, 401);
  };
  await assert.rejects(apiClient.get("/wallet"));
  assert.equal(requests, 2); assert.equal(refreshes, 1);
});

test("logout during refresh cannot resurrect the session or replay the old mutation", async () => {
  const started = deferred(), gate = deferred(); let writes = 0;
  apiClient.defaults.adapter = async config => {
    if (config.url === "/auth/csrf") return response(config, { csrfToken: "csrf" });
    if (config.url === "/auth/refresh") { started.resolve(); await gate.promise; return response(config, { accessToken: "fresh", csrfToken: "csrf" }); }
    writes++; reject(config, 401);
  };
  const pending = apiClient.post("/courses", { title: "A" });
  const rejected = assert.rejects(pending, error => error.code === "SESSION_CHANGED");
  await started.promise; setAccessToken(""); setCsrfToken(""); gate.resolve(); await rejected;
  assert.equal(hasAccessToken(), false); assert.equal(writes, 1);
});

test("aborting while refresh is pending does not resend the cancelled upload request", async () => {
  const started = deferred(), gate = deferred(), abort = new AbortController(); let writes = 0;
  apiClient.defaults.adapter = async config => {
    if (config.url === "/auth/csrf") return response(config, { csrfToken: "csrf" });
    if (config.url === "/auth/refresh") { started.resolve(); await gate.promise; return response(config, { accessToken: "fresh", csrfToken: "csrf" }); }
    writes++; reject(config, 401);
  };
  const pending = apiClient.post("/multipart/sign", {}, { signal: abort.signal });
  const rejected = assert.rejects(pending, error => error.code === "ERR_CANCELED");
  await started.promise; abort.abort(); gate.resolve(); await rejected;
  assert.equal(writes, 1);
});

test("manual retry keeps the same mutation key; a later successful operation gets a new key", async () => {
  const keys = []; let fail = true;
  apiClient.defaults.adapter = async config => {
    keys.push(config.headers.get("Idempotency-Key"));
    if (fail) { fail = false; reject(config, 503, "UNAVAILABLE"); }
    return response(config);
  };
  await assert.rejects(mutateApi("post", "/courses", { title: "A" }));
  await mutateApi("post", "/courses", { title: "A" });
  await mutateApi("post", "/courses", { title: "A" });
  assert.ok(keys[0]); assert.equal(keys[0], keys[1]); assert.notEqual(keys[1], keys[2]);
});

test("different payloads and accounts cannot reuse an uncertain mutation key", async () => {
  const keys = [];
  apiClient.defaults.adapter = async config => { keys.push(config.headers.get("Idempotency-Key")); reject(config, 503, "UNAVAILABLE"); };
  await assert.rejects(mutateApi("post", "/courses", { title: "A" }));
  await assert.rejects(mutateApi("post", "/courses", { title: "B" }));
  setAccessToken("other-user");
  await assert.rejects(mutateApi("post", "/courses", { title: "A" }));
  assert.equal(new Set(keys).size, 3);
});

test("a confirmed readiness rejection gets a new key after processing completes", async () => {
  const keys = []; let ready = false;
  apiClient.defaults.adapter = async config => {
    keys.push(config.headers.get("Idempotency-Key"));
    if (!ready) reject(config, 409, "VIDEO_NOT_READY");
    return response(config);
  };
  await assert.rejects(mutateApi("post", "/courses/a/submit"));
  ready = true; await mutateApi("post", "/courses/a/submit");
  assert.notEqual(keys[0], keys[1]);
});

test("temporary refresh failure preserves credentials and permits a later recovery", async () => {
  let unavailable = true, refreshes = 0;
  apiClient.defaults.adapter = async config => {
    if (config.url === "/auth/csrf") return response(config, { csrfToken: "csrf" });
    if (config.url === "/auth/refresh") {
      refreshes++;
      if (unavailable) reject(config, 503, "UNAVAILABLE");
      return response(config, { accessToken: "fresh", csrfToken: "csrf" });
    }
    if (config.headers.Authorization === "Bearer old") reject(config, 401);
    return response(config);
  };
  await assert.rejects(apiClient.get("/wallet"), error => error.status === 503);
  assert.equal(hasAccessToken(), true);
  unavailable = false; await apiClient.get("/wallet");
  assert.equal(refreshes, 2);
});
