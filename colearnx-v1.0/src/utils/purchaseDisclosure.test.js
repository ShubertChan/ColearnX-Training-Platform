import test from "node:test";
import assert from "node:assert/strict";
import { cartItemKey, deliveryDisclosures, hasPurchasePolicy, refundDisclosure, VIDEO_REFUND_PROGRESS_LIMIT } from "./purchaseDisclosure.js";

test("delivery copy separates cloud download and local/live coordination", () => {
  const copy = deliveryDisclosures({ deliveryModes: ["cloud", "local", "live"] });
  assert.match(copy[0], /download/i);
  assert.match(copy[1], /arrange fulfilment/i);
  assert.match(copy[2], /arrange the session/i);
});

test("only explicitly tracked online video receives the 10 percent disclosure", () => {
  assert.equal(deliveryDisclosures({ deliveryModes: ["cloud"] }).some((line) => line.includes("10%")), false);
  assert.equal(deliveryDisclosures({ onlineVideo: true }).some((line) => line.includes("10%")), true);
  assert.equal(VIDEO_REFUND_PROGRESS_LIMIT, 0.1);
});

test("mixed cart keys keep course and content identifiers distinct", () => {
  assert.equal(cartItemKey({ kind: "course", id: "same" }), "course:same");
  assert.equal(cartItemKey({ kind: "content", id: "same" }), "content:same");
});

test("checkout requires an exact server policy preview", () => {
  assert.equal(hasPurchasePolicy({}), false);
  assert.equal(hasPurchasePolicy({ refundPolicyPreview: { summary: "Refundable within seven days." } }), true);
  assert.equal(hasPurchasePolicy({ refundPolicySummary: "Final sale." }), true);
  assert.equal(hasPurchasePolicy({ refundPolicyPreview: { code: "NO_REFUND" } }), false);
  assert.equal(refundDisclosure({ refundPolicyPreview: { description: "Final sale." } }), "Final sale.");
});
