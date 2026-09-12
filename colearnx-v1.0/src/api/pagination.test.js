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
