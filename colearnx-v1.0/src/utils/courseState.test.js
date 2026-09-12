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

test("recorded media allows exactly 10 percent without a protected-file download", () => {
  assert.equal(
    getRefundInfo(hosted, new Date("2026-09-30T00:00:00.000Z")).eligible,
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

test("recorded media rejects a protected-file download", () => {
  assert.equal(
    getRefundInfo({ ...hosted, downloaded: true }).eligible,
    false,
  );
});

test("Local delivery uses the self-arranged 72-hour boundary", () => {
  const local = {
    purchased: true,
    deliveryModes: ["local"],
    startsAt: "2026-09-10T12:00:00.000Z",
  };
  assert.equal(
    getRefundInfo(local, new Date("2026-09-07T12:00:00.000Z")).eligible,
    true,
  );
  assert.equal(
    getRefundInfo(local, new Date("2026-09-07T12:00:00.001Z")).eligible,
    false,
  );
});

test("unowned recorded media exposes the 10-percent, no-download policy preview", () => {
  const info = getRefundInfo({ ...hosted, purchased: false });
  assert.equal(info.eligible, false);
  assert.equal(info.policyPreview, true);
  assert.match(info.detail, /no protected-file download/);
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
