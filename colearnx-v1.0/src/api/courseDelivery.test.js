import test from "node:test";
import assert from "node:assert/strict";
import { apiClient } from "./client.js";
import { recordCourseProgress } from "./courseDelivery.js";

test("progress adapter never forwards accumulated client watch time or refund claims", async () => {
  const original = apiClient.post; let request;
  apiClient.post = async (...args) => { request = args; return { data: { data: {} } }; };
  try {
    await recordCourseProgress("order item", { sessionId: "s", sequence: 1, event: "playing", positionSeconds: 10, playbackRate: 1, clientMonotonicMs: 20, watchedSeconds: 100, watchedRanges: [[0, 100]], refundEligible: true });
    assert.equal(request[0], "/order-items/order%20item/progress");
    assert.equal(request[1].watchedSeconds, undefined); assert.equal(request[1].refundEligible, undefined);
    assert.equal(request[2].fetchOptions.keepalive, true);
    assert.throws(() => recordCourseProgress("id", { sessionId: "s", sequence: 1, event: "hidden" }));
  } finally { apiClient.post = original; }
});
