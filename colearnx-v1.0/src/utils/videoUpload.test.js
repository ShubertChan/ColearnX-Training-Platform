import test from "node:test";
import assert from "node:assert/strict";
import { approvedUploadUrl, readUpload, saveUpload, sameVideoFile, uploadStorageKey, uploadVideo } from "./videoUpload.js";

test("upload destinations require the exact deployment-configured origin", () => {
  const origin = "https://account.r2.cloudflarestorage.com";
  assert.equal(approvedUploadUrl(`${origin}/part?signature=abc`, origin), `${origin}/part?signature=abc`);
  assert.equal(approvedUploadUrl("https://other.r2.cloudflarestorage.com/part", origin), "");
  assert.equal(approvedUploadUrl(`${origin}/part`, ""), "");
  assert.equal(approvedUploadUrl("http://account.r2.cloudflarestorage.com/part", origin), "");
  assert.equal(approvedUploadUrl("https://user:pass@account.r2.cloudflarestorage.com/part", origin), "");
});

const chunk = 5 * 1024 * 1024;
const file = { size: chunk * 2 + 4, slice(start, end) { return { size: end - start }; } };
function fixture(overrides = {}) {
  const calls = [];
  return { calls, service: {
    createVideoUpload: async (_id, _file, key) => { calls.push(["create", key]); return { videoVersionId: "new" }; },
    listVideoParts: async () => ({ partSizeBytes: chunk, parts: [{ partNumber: 1, etag: "first", sizeBytes: chunk }] }),
    signVideoPart: async (_id, _version, n) => { calls.push(["sign", n]); return { url: "test" }; },
    finishVideoParts: async (_id, _version, parts, key) => calls.push(["complete", parts, key]),
    completeVideoUpload: async (_id, _version, key) => calls.push(["verify", key]), ...overrides,
  } };
}
test("resume lists accepted parts and uploads only missing parts before verification", async () => {
  const { service, calls } = fixture();
  await uploadVideo({ courseId: "c", file, saved: { versionId: "old-pending", requestKey: "stable" }, service, putPart: async () => "etag", onSaved() {}, onProgress() {} });
  assert.deepEqual(calls.filter(c => c[0] === "sign"), [["sign", 2], ["sign", 3]]);
  assert.deepEqual(calls.at(-1), ["verify", "stable-verify"]);
  assert.equal(calls.find(c => c[0] === "complete")[1].length, 3);
});
test("lost completion response resumes verification with the same idempotency key", async () => {
  const { service, calls } = fixture({ listVideoParts: async () => ({ partSizeBytes: chunk, parts: [], completed: true }) });
  await uploadVideo({ courseId: "c", file, saved: { versionId: "v", requestKey: "stable" }, service, onSaved() {}, onProgress() {} });
  assert.deepEqual(calls, [["verify", "stable-verify"]]);
});
test("pause aborts without completing a partial source", async () => {
  const { service, calls } = fixture(); const abort = new AbortController();
  await assert.rejects(uploadVideo({ courseId: "c", file, saved: { versionId: "v", requestKey: "stable" }, service, signal: abort.signal, putPart: async () => { abort.abort(); throw new DOMException("Paused", "AbortError"); }, onSaved() {}, onProgress() {} }));
  assert.ok(!calls.some(c => c[0] === "complete" || c[0] === "verify"));
});
test("bad remote part sizes are rejected instead of combining mismatched bytes", async () => {
  const { service } = fixture({ listVideoParts: async () => ({ partSizeBytes: chunk, parts: [{ partNumber: 1, etag: "x", sizeBytes: 1 }] }) });
  await assert.rejects(uploadVideo({ courseId: "c", file, saved: { versionId: "v" }, service, onProgress() {}, onSaved() {} }));
});
test("resume metadata is account-scoped and contains no signed links or tokens", () => {
  const values = new Map(); const storage = { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) };
  const key = uploadStorageKey("a", "c");
  saveUpload(storage, key, { requestKey: "stable", versionId: "v", file: { fingerprint: "hash" }, url: "SECRET", token: "SECRET" });
  assert.ok(!values.get(key).includes("SECRET")); assert.equal(readUpload(storage, uploadStorageKey("b", "c")), null);
  assert.equal(sameVideoFile({ name: "a", size: 1, fingerprint: "x" }, { name: "a", size: 1, fingerprint: "y" }), false);
});
