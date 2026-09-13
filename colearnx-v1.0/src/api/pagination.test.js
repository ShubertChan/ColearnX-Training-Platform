import test from "node:test";
import assert from "node:assert/strict";
import { apiClient } from "./client.js";
import { listAllPages } from "./pagination.js";
test("cursor lists include the 101st refund request", async () => {
  const original = apiClient.get; const calls = [];
  apiClient.get = async (_path, { params }) => { calls.push(params); return params.cursor ? { data: { data: [{ id: "101" }], meta: {} } } : { data: { data: Array.from({ length: 100 }, (_, i) => ({ id: String(i) })), meta: { nextCursor: "next" } } }; };
  try { assert.equal((await listAllPages("/admin/refund-requests")).length, 101); assert.equal(calls[1].cursor, "next"); } finally { apiClient.get = original; }
});
test("repeated explicit cursor reports an incomplete list", async () => {
  const original = apiClient.get;
  apiClient.get = async () => ({ data: { data: [{ id: "1" }], meta: { nextCursor: "same" } } });
  try { await assert.rejects(listAllPages("/items"), /repeated/); } finally { apiClient.get = original; }
});

const restartError = () => Object.assign(new Error("Restart this list."), { status: 400, code: "CURSOR_RESTART_REQUIRED" });
const listPage = (items, nextCursor) => ({ data: { data: items, meta: nextCursor ? { nextCursor } : { hasNext: false } } });

for (const path of ["/admin/reports", "/admin/audit-logs"]) {
  test(`${path} restarts an old cursor once and discards stale results`, async () => {
    const original = apiClient.get;
    const calls = [];
    const filters = { status: "OPEN", actorId: "actor-1", action: "UPDATE", limit: 100 };
    const oldCursor = "opaque/v1+token==";
    const newCursor = "opaque/v2+token==";
    const staleItems = [{ id: "stale" }, { id: "shared", value: "before restart" }];
    const freshItems = [{ id: "shared", value: "after restart" }, { id: "fresh" }];
    apiClient.get = async (requestPath, { params }) => {
      calls.push({ path: requestPath, params });
      switch (calls.length) {
        case 1: return listPage(staleItems, oldCursor);
        case 2: throw restartError();
        case 3: return listPage([freshItems[0]], newCursor);
        case 4: return listPage([freshItems[1]]);
        default: throw new Error("Unexpected extra request.");
      }
    };
    try {
      assert.deepEqual(await listAllPages(path, filters), freshItems);
      assert.deepEqual(calls, [
        { path, params: { ...filters } },
        { path, params: { ...filters, cursor: oldCursor } },
        { path, params: { ...filters } },
        { path, params: { ...filters, cursor: newCursor } },
      ]);
      assert.deepEqual(filters, { status: "OPEN", actorId: "actor-1", action: "UPDATE", limit: 100 });
    } finally { apiClient.get = original; }
  });
}

test("cursor restart clears previously seen page cursors", async () => {
  const original = apiClient.get;
  let calls = 0;
  apiClient.get = async () => {
    calls++;
    if (calls === 2) throw restartError();
    if (calls === 1 || calls === 3) return listPage([{ id: "first" }], "opaque-reused-token");
    if (calls === 4) return listPage([{ id: "last" }]);
    throw new Error("Unexpected extra request.");
  };
  try {
    assert.deepEqual(await listAllPages("/admin/reports"), [{ id: "first" }, { id: "last" }]);
    assert.equal(calls, 4);
  } finally { apiClient.get = original; }
});

test("a second cursor restart error propagates unchanged", async () => {
  const original = apiClient.get;
  const error = restartError();
  let calls = 0;
  apiClient.get = async () => {
    calls++;
    if (calls === 1 || calls === 3) return listPage([{ id: "first" }], `opaque-${calls}`);
    throw error;
  };
  try {
    await assert.rejects(listAllPages("/admin/audit-logs"), (actual) => actual === error);
    assert.equal(calls, 4);
  } finally { apiClient.get = original; }
});

test("a cursor restart error on the first page propagates unchanged", async () => {
  const original = apiClient.get;
  const error = restartError();
  let calls = 0;
  apiClient.get = async () => { calls++; throw error; };
  try {
    await assert.rejects(listAllPages("/admin/reports"), (actual) => actual === error);
    assert.equal(calls, 1);
  } finally { apiClient.get = original; }
});

for (const [name, path, status, code] of [
  ["malformed cursor", "/admin/reports", 400, "INVALID_CURSOR"],
  ["unrelated error", "/admin/audit-logs", 500, "INTERNAL_ERROR"],
  ["network error", "/admin/reports", 0, "NETWORK_ERROR"],
  ["authentication error", "/admin/reports", 401, "CURSOR_RESTART_REQUIRED"],
  ["authorization error", "/admin/audit-logs", 403, "CURSOR_RESTART_REQUIRED"],
  ["unrelated endpoint", "/admin/refund-requests", 400, "CURSOR_RESTART_REQUIRED"],
  ["similarly named endpoint", "/admin/reports/archive", 400, "CURSOR_RESTART_REQUIRED"],
]) {
  test(`${name} does not restart pagination`, async () => {
    const original = apiClient.get;
    const error = Object.assign(new Error(name), { status, code });
    let calls = 0;
    apiClient.get = async () => {
      calls++;
      if (calls === 1) return listPage([{ id: "first" }], "opaque-token");
      throw error;
    };
    try {
      await assert.rejects(listAllPages(path), (actual) => actual === error);
      assert.equal(calls, 2);
    } finally { apiClient.get = original; }
  });
}
