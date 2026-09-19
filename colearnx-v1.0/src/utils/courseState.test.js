import test from "node:test";
import assert from "node:assert/strict";
import { getDeliveryLabel, getLearningStatus, getLiveStatus, getRefundInfo } from "./courseState.js";

test("cloud download does not imply online-video progress tracking", () => {
  const info = getRefundInfo({ purchased: true, deliveryModes: ["cloud"], duration: 100, watched: 10 });
  assert.equal(info.progress, null);
  assert.equal(info.progressConditionMet, null);
  assert.match(info.detail, /does not create a viewing-progress rule/);
});

test("video refund UI never infers eligibility from locally calculated ratios", () => {
  const atLimit = getRefundInfo({ purchased: true, onlineVideo: true, totalDurationSeconds: 100, watchedSeconds: 10 });
  assert.equal(atLimit.progressConditionMet, null);
  assert.equal(atLimit.progress, null);
  const server = getRefundInfo({ purchased: true, onlineVideo: true, watchedRatio: 0.100001, refundEligibility: { eligible: false, progressConditionMet: false } });
  assert.equal(server.progressConditionMet, false);
  assert.equal(server.eligible, false);
});

test("server eligibility is authoritative", () => {
  assert.equal(getRefundInfo({ purchased: true, onlineVideo: true, totalDurationSeconds: 100, watchedSeconds: 0 }).eligible, false);
  assert.equal(getRefundInfo({ purchased: true, refundEligible: true }).eligible, true);
});

test("learning and live states are derived consistently", () => {
  assert.equal(getLearningStatus({ duration: 100, watched: 0 }), "Unwatched");
  assert.equal(getLearningStatus({ duration: 100, watched: 30 }), "Watching");
  assert.equal(getLearningStatus({ duration: 100, watched: 100 }), "Watched");
  assert.equal(getLiveStatus({ deliveryModes: ["live"], startsAt: "2026-08-29T10:00:00.000Z", duration: 60 }, new Date("2026-08-29T12:00:00.000Z")), "Ended");
});

test("delivery labels use the current three channels", () => {
  assert.equal(getDeliveryLabel({ deliveryModes: ["cloud", "live"] }), "Cloud + Live");
});
