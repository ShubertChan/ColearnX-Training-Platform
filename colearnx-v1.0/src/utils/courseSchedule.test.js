import assert from "node:assert/strict";
import test from "node:test";
import { courseUpdatePayload, localDateTime } from "./courseSchedule.js";
const item = { startsAt: "2026-10-01T02:00:30.123Z", endsAt: "2026-10-01T04:00:00Z", timezone: "Asia/Singapore", categoryId: "category", capacity: 12, deliveryModes: ["cloud"], onlineVideo: true };
const form = { title: " Video ", description: " Description ", pricePoints: "20", startsAt: localDateTime(item.startsAt), endsAt: localDateTime(item.endsAt), fulfilmentInstructions: "", trainerContact: "", joinUrl: "" };
test("metadata-only edits preserve exact dates and video delivery configuration", () => {
  const result = courseUpdatePayload(item, form, " metadata update ");
  assert.equal(result.startsAt, item.startsAt); assert.equal(result.endsAt, item.endsAt);
  assert.equal(result.progressTrackingType, "online_video"); assert.deepEqual(result.deliveryModes, ["cloud"]);
  assert.equal(result.categoryId, "category"); assert.equal(result.capacity,12); assert.equal(result.timezone,"Asia/Singapore");
  assert.equal(result.title,"Video"); assert.equal(result.changeSummary,"metadata update");
});
test("video update rejects a missing or inverted schedule", () => {
  assert.throws(() => courseUpdatePayload(item,{...form, startsAt:""},"update"), /start time/);
  assert.throws(() => courseUpdatePayload(item,{...form, endsAt:"2020-01-01T00:00"},"update"), /End time/);
});
test("a changed local date is sent as a UTC timestamp", () => {
  const value = "2026-10-02T10:00";
  const result = courseUpdatePayload(item,{...form,startsAt:value,endsAt:""},"update");
  assert.equal(result.startsAt,new Date(value).toISOString()); assert.equal(result.endsAt,null);
});
