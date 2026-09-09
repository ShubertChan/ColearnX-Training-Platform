import assert from "node:assert/strict";
import test from "node:test";
import { apiClient } from "./client.js";
import { listOrders } from "./commerce.js";

test("listOrders follows every server cursor", async (context) => {
  const originalGet = apiClient.get;
  const calls = [];
  context.after(() => {
    apiClient.get = originalGet;
  });
  apiClient.get = async (path, config) => {
    calls.push({ path, params: config?.params });
    if (!config?.params?.cursor) {
      return { data: { data: [{ id: "newer" }], meta: { nextCursor: "2026-09-09T12:00:00.000Z" } } };
    }
    return { data: { data: [{ id: "older" }], meta: { nextCursor: null } } };
  };

  assert.deepEqual(await listOrders(), [{ id: "newer" }, { id: "older" }]);
  assert.deepEqual(calls, [
    { path: "/orders", params: { limit: 100 } },
    { path: "/orders", params: { limit: 100, cursor: "2026-09-09T12:00:00.000Z" } },
  ]);
});
