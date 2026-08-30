import test from "node:test";
import assert from "node:assert/strict";
import {
  getDeliveryLabel,
  getLearningStatus,
  getLiveStatus,
  getRefundInfo,
} from "./courseState.js";

const purchaseTime = "2026-08-29T00:00:00.000Z";
const hosted = {
  purchased: true,
  purchasedAt: purchaseTime,
  deliveryModes: ["cloud"],
  duration: 100,
  watched: 10,
};

test("hosted refund includes exactly 10 percent within 72 hours", () => {
  assert.equal(
    getRefundInfo(hosted, new Date("2026-08-31T23:59:59.000Z")).eligible,
    true,
  );
});

test("hosted refund rejects progress above 10 percent", () => {
  assert.equal(
    getRefundInfo(
      { ...hosted, watched: 11 },
      new Date("2026-08-29T12:00:00.000Z"),
    ).eligible,
    false,
  );
});

test("hosted refund includes exactly 72 hours and rejects later requests", () => {
  assert.equal(
    getRefundInfo(hosted, new Date("2026-09-01T00:00:00.000Z")).eligible,
    true,
  );
  assert.equal(
    getRefundInfo(hosted, new Date("2026-09-01T00:00:00.001Z")).eligible,
    false,
  );
});

test("local delivery is non-refundable before and after delivery", () => {
  const local = {
    purchased: true,
    deliveryModes: ["local"],
    downloaded: false,
  };
  assert.equal(getRefundInfo(local).eligible, false);
  assert.equal(getRefundInfo({ ...local, downloaded: true }).eligible, false);
});

test("unowned hosted course exposes a policy preview", () => {
  const info = getRefundInfo({ ...hosted, purchased: false });
  assert.equal(info.eligible, false);
  assert.equal(info.policyPreview, true);
  assert.match(info.detail, /72 hours/);
  assert.match(info.detail, /10%/);
});

test("learning and live states are derived consistently", () => {
  assert.equal(getLearningStatus({ duration: 100, watched: 0 }), "Unwatched");
  assert.equal(getLearningStatus({ duration: 100, watched: 30 }), "Watching");
  assert.equal(getLearningStatus({ duration: 100, watched: 100 }), "Watched");
  assert.equal(
    getLiveStatus(
      {
        deliveryModes: ["live"],
        startsAt: "2026-08-29T10:00:00.000Z",
        duration: 60,
      },
      new Date("2026-08-29T12:00:00.000Z"),
    ),
    "Ended",
  );
});

test("live refund includes the exact 72-hour boundary", () => {
  const live = {
    purchased: true,
    deliveryModes: ["live", "record"],
    startsAt: "2026-09-10T12:00:00.000Z",
    duration: 60,
  };
  assert.equal(
    getRefundInfo(live, new Date("2026-09-07T12:00:00.000Z")).eligible,
    true,
  );
  assert.equal(
    getRefundInfo(live, new Date("2026-09-07T12:00:00.001Z")).eligible,
    false,
  );
});

test("delivery labels support valid combinations", () => {
  assert.equal(
    getDeliveryLabel({ deliveryModes: ["cloud", "record"] }),
    "Cloud + Record",
  );
});
