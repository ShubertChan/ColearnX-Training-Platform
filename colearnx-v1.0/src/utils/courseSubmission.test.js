import test from "node:test";
import assert from "node:assert/strict";
import { attachmentInventory, canSubmitCourse } from "./courseSubmission.js";
const input = { video: { ready: true, busy: false }, onlineVideo: true, videoEnabled: true };
test("both video submission surfaces block unavailable or unfinished attachments", () => {
  for (const files of [null, { loading: true }, { error: true }, { activeCount: 1 }, attachmentInventory([{ status: "upload_pending" }])]) {
    assert.equal(canSubmitCourse({ ...input, files }), false);
  }
  assert.equal(canSubmitCourse({ ...input, files: attachmentInventory([]) }), true);
  assert.equal(canSubmitCourse({ ...input, files: attachmentInventory([{ status: "ready" }]) }), true);
  assert.equal(canSubmitCourse({ ...input, videoEnabled: false, files: attachmentInventory([]) }), false);
});
test("non-video cloud courses still require a ready attachment", () => {
  assert.equal(canSubmitCourse({ needsFile: true, files: attachmentInventory([]) }), false);
  assert.equal(canSubmitCourse({ needsFile: true, files: attachmentInventory([{ status: "ready" }]) }), true);
});
