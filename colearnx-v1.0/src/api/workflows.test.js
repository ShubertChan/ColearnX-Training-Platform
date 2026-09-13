import assert from "node:assert/strict";
import test from "node:test";
import { apiClient } from "./client.js";
import { adjustPoints, decideReport, serviceMessage, submitReport } from "./workflows.js";

test("reports and points adapters use their protected server contracts with the caller's stable key", async () => {
  const originalPost = apiClient.post;
  const calls = [];
  apiClient.post = async (url, body, options) => {
    calls.push({ url, body, options });
    return { data: { data: { accepted: true } } };
  };
  try {
    await submitReport({ kind: "content", productId: "content-version-id", category: "misleading", reason: "The supplied description does not match the item." }, "report-key-123");
    await decideReport("report-id", { decision: "dismissed", reason: "The evidence does not support the report." }, "decision-key-123");
    await adjustPoints({ userId: "user-id", deltaPoints: 12, reason: "Verified support adjustment." }, "points-key-123");
    assert.deepEqual(calls, [
      { url: "/reports", body: { kind: "content", productId: "content-version-id", category: "misleading", reason: "The supplied description does not match the item." }, options: { headers: { "Idempotency-Key": "report-key-123" } } },
      { url: "/admin/reports/report-id/decision", body: { decision: "dismissed", reason: "The evidence does not support the report." }, options: { headers: { "Idempotency-Key": "decision-key-123" } } },
      { url: "/admin/points/adjustments", body: { userId: "user-id", deltaPoints: 12, reason: "Verified support adjustment." }, options: { headers: { "Idempotency-Key": "points-key-123" } } },
    ]);
  } finally {
    apiClient.post = originalPost;
  }
});

test("a missing API route is distinguished from a missing individual report", () => {
  assert.match(serviceMessage({ code: "NOT_FOUND", message: "No API route matches GET /api/v1/admin/reports." }), /not available/);
  assert.equal(serviceMessage({ code: "REPORT_NOT_FOUND", message: "Report was not found." }), "Report was not found.");
});
