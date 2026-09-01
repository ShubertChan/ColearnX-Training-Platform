import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PRIVATE_ASSET_BYTES,
  validatePrivateAsset,
} from "./uploadPolicy.js";

test("private asset policy accepts the staging MIME allow-list", () => {
  for (const file of [
    { name: "guide.pdf", type: "application/pdf", size: 100 },
    { name: "pack.zip", type: "application/x-zip-compressed", size: 100 },
    { name: "cover.webp", type: "image/webp", size: 100 },
    { name: "lesson.mp4", type: "video/mp4", size: 100 },
  ]) {
    assert.equal(validatePrivateAsset(file).valid, true);
  }
});

test("private asset policy rejects empty, oversized and unsupported files", () => {
  assert.equal(validatePrivateAsset({ name: "empty.pdf", type: "application/pdf", size: 0 }).code, "FILE_EMPTY");
  assert.equal(
    validatePrivateAsset({ name: "huge.pdf", type: "application/pdf", size: MAX_PRIVATE_ASSET_BYTES + 1 }).code,
    "CONTENT_FILE_TOO_LARGE",
  );
  assert.equal(validatePrivateAsset({ name: "script.exe", type: "application/x-msdownload", size: 100 }).code, "CONTENT_FILE_TYPE_NOT_ALLOWED");
});

test("extension fallback recognises browsers that omit ZIP MIME", () => {
  const result = validatePrivateAsset({ name: "learning-pack.ZIP", type: "", size: 200 });
  assert.deepEqual(result, { valid: true, mediaType: "application/zip" });
});
