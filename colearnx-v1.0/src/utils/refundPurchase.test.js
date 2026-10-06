import { test } from "node:test";
import assert from "node:assert/strict";
import { refundPurchase, refundReasonError, refundReviewEvidence } from "./refundPurchase.js";

test("refund reasons use trimmed length and accept short Chinese reasons", () => {
  for (const reason of ["不想学", "不想学了", "  abc  ", "a".repeat(2000)]) assert.equal(refundReasonError(reason), "");
  for (const reason of ["", "   ", " a ", "ab"]) assert.match(refundReasonError(reason), /at least 3/);
  assert.match(refundReasonError("a".repeat(2001)), /2000/);
});

test("refund selects the purchased order item without needing the public catalogue", () => {
  const orders = [{ items: [
    { id: "old", productId: "course", kind: "course", fulfilmentStatus: "fulfilled", courseVideoVersionId: "v1", refundPolicySnapshot: { summary: "Original policy" } },
    { id: "new", productId: "course", kind: "course", fulfilmentStatus: "paid", courseVideoVersionId: "v2" },
    { id: "refunded", productId: "course", kind: "course", fulfilmentStatus: "refunded" },
  ] }];
  assert.equal(refundPurchase(orders, "course", "old").courseVideoVersionId, "v1");
  assert.equal(refundPurchase(orders, "course", "old").refundPolicySnapshot.summary, "Original policy");
  assert.equal(refundPurchase(orders, "course", "new").orderItemId, "new");
  assert.equal(refundPurchase(orders, "course", "missing"), null);
  assert.equal(refundPurchase(orders, "other", "old"), null);
  assert.equal(refundPurchase(orders, "course", "refunded"), null);
});

test("admin approval uses the same frozen evidence as the displayed refund decision", () => {
  const snapshot = { refundEligibility: { eligible: false } };
  assert.deepEqual(refundReviewEvidence({ eligibility: { eligible: true }, eligibilitySnapshot: snapshot }), { evidence: snapshot, serverEligible: false });
  assert.equal(refundReviewEvidence({ eligibilitySnapshot: { eligibility: { eligible: true } } }).serverEligible, true);
  assert.equal(refundReviewEvidence({ eligibilitySnapshot: {}, eligibility: { eligible: true } }).serverEligible, undefined);
  assert.equal(refundReviewEvidence({ evidence: { refundEligibility: { eligible: false } }, eligibility: { eligible: true } }).serverEligible, false);
});
