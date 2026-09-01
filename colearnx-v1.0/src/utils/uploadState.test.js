import test from "node:test";
import assert from "node:assert/strict";
import {
  hasReadyAsset,
  initialUploadState,
  uploadReducer,
} from "./uploadState.js";

const file = { name: "guide.pdf", size: 100 };
const oldAsset = { assetId: "old", filename: "old.pdf", status: "ready", sizeBytes: 80 };
const newAsset = { assetId: "new", filename: "guide.pdf", status: "ready", sizeBytes: 100 };

test("upload state reaches uploaded only after the ready action", () => {
  let state = initialUploadState();
  state = uploadReducer(state, { type: "SELECT", file });
  state = uploadReducer(state, { type: "PREPARE" });
  state = uploadReducer(state, { type: "UPLOAD" });
  state = uploadReducer(state, { type: "PROGRESS", progress: 100, uploadedBytes: 100, totalBytes: 100 });
  assert.equal(state.status, "uploading");
  assert.equal(hasReadyAsset(state), false);
  state = uploadReducer(state, { type: "VERIFY" });
  assert.equal(state.status, "verifying");
  assert.equal(hasReadyAsset(state), false);
  state = uploadReducer(state, { type: "READY", asset: newAsset });
  assert.equal(state.status, "uploaded");
  assert.equal(hasReadyAsset(state), true);
});

test("failed replacement preserves the old verified asset", () => {
  let state = initialUploadState(oldAsset);
  state = uploadReducer(state, { type: "SELECT", file });
  state = uploadReducer(state, { type: "PREPARE" });
  state = uploadReducer(state, { type: "FAIL", message: "network failed" });
  assert.equal(state.status, "error");
  assert.equal(state.asset.assetId, "old");
  assert.equal(hasReadyAsset(state), true);
});

test("cancelled first upload never creates a ready asset", () => {
  let state = uploadReducer(initialUploadState(), { type: "SELECT", file });
  state = uploadReducer(state, { type: "UPLOAD" });
  state = uploadReducer(state, { type: "CANCEL" });
  assert.equal(state.status, "cancelled");
  assert.equal(hasReadyAsset(state), false);
});
