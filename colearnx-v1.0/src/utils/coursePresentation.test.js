import assert from "node:assert/strict";
import test from "node:test";
import { getCourseTypeLabel, isVideoCourse } from "./coursePresentation.js";

test("course type labels preserve the video and instructor-led distinction", () => {
  assert.equal(isVideoCourse({ progressTrackingType: "online_video" }), true);
  assert.equal(getCourseTypeLabel({ deliveryModes: ["cloud"], courseVideoVersionId: "purchased-version" }), "Video course");
  assert.equal(getCourseTypeLabel({ deliveryModes: ["cloud"], progressTrackingType: "online_video" }), "Video course");
  assert.equal(getCourseTypeLabel({ deliveryModes: ["live"] }), "Instructor-led course · Online live");
  assert.equal(getCourseTypeLabel({ deliveryModes: ["local"] }), "Instructor-led course · Offline arrangement");
  assert.equal(getCourseTypeLabel({ deliveryModes: ["cloud"] }), "Course files");
});
