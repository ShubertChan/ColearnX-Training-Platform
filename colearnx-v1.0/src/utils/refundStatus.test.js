import { test } from "node:test";
import assert from "node:assert/strict";
import { refundStatus } from "./refundStatus.js";

test("refund status uses the newest request regardless of response order", () => {
  const item = { refundRecords: [{ status: "rejected", requestedAt: "2026-10-01" }, { status: "pending", requestedAt: "2026-10-02" }] };
  assert.equal(refundStatus(item).code, "pending");
  assert.equal(refundStatus({ ...item, refundRecords: item.refundRecords.toReversed() }).code, "pending");
  assert.equal(refundStatus(item).blocksRequest, true);
});

test("only confirmed refunded fulfilment shows returned points", () => {
  const item = { refundRecords: [{ status: "approved" }] };
  assert.equal(refundStatus(item).code, "approved");
  assert.doesNotMatch(refundStatus(item).description, /points have been returned/);
  assert.equal(refundStatus({ ...item, fulfilmentStatus: "refunded" }).code, "refunded");
  assert.equal(refundStatus({ fulfilmentStatus: "refunded" }).blocksRequest, true);
});

test("rejected and cancelled requests allow retry while unknown states block duplicates", () => {
  for (const status of ["rejected", "cancelled"]) assert.equal(refundStatus({ refundRecords: [{ status }] }).blocksRequest, false);
  assert.equal(refundStatus({ refundRecords: [{ status: "new-server-status" }] }).blocksRequest, true);
  assert.equal(refundStatus({ refundRecords: [] }), null);
  assert.equal(refundStatus(null), null);
});
