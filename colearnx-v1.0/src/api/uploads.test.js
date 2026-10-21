import assert from "node:assert/strict";
import test from "node:test";
import { apiClient } from "./client.js";
import { contentAssetApi, courseAssetApi, listContentAssets, requestContentDownloadUrl } from "./uploads.js";

test("purchased downloads preserve the selected attachment id", async () => {
  const originalGet = apiClient.get;
  const originalPost = apiClient.post;
  const calls = [];
  apiClient.get = async (url) => {
    calls.push({ method: "get", url });
    return { data: { data: { assets: [{ assetId: "asset-video", status: "ready" }, { assetId: "asset-pdf", status: "ready" }] } } };
  };
  apiClient.post = async (url, body) => {
    calls.push({ method: "post", url, body });
    return { data: { data: { filename: "notes.pdf", downloadUrl: "https://temporary-download.example" } } };
  };

  try {
    const assets = await listContentAssets("version-1");
    const result = await requestContentDownloadUrl("version-1", "asset-pdf");
    assert.equal(assets.length, 2);
    assert.equal(result.filename, "notes.pdf");
    assert.deepEqual(calls, [
      { method: "get", url: "/content-versions/version-1/assets" },
      { method: "post", url: "/content-versions/version-1/download-url", body: { assetId: "asset-pdf" } },
    ]);
  } finally {
    apiClient.get = originalGet;
    apiClient.post = originalPost;
  }
});

test("content and course retries send the caller's stable reservation key", async () => {
  const originalPost = apiClient.post;
  const calls = [];
  apiClient.post = async (url, body, options) => {
    calls.push({ url, body, options });
    return { data: { data: { assetId: "same-asset" } } };
  };
  try {
    const file = { name: "lesson.mp4", type: "video/mp4", size: 100 };
    for (const api of [contentAssetApi, courseAssetApi]) {
      await api.request("draft", file, { requestKey: "same-request" });
      await api.request("draft", file, { requestKey: "same-request" });
    }
    assert.deepEqual(calls.map(call => call.url), [
      "/content-versions/draft/upload-intents", "/content-versions/draft/upload-intents",
      "/courses/draft/upload-intents", "/courses/draft/upload-intents",
    ]);
    assert.ok(calls.every(call => call.options.headers["Idempotency-Key"] === "same-request"));
  } finally { apiClient.post = originalPost; }
});

test("W8 security rejections map to fixed, translatable messages that do not reveal which check fired", async () => {
  const { getSafeUploadError } = await import("./uploads.js");
  const rejected = getSafeUploadError({ code: "UPLOAD_CONTENT_REJECTED", message: "server text", requestId: "req-1" });
  assert.equal(rejected.message, "This file was blocked by the security check. Upload the original document in a supported format.");
  assert.equal(rejected.requestId, "req-1");
  assert.doesNotMatch(rejected.message, /executable|malware|virus|zip/i);
  assert.match(getSafeUploadError({ code: "UPLOAD_SCAN_UNAVAILABLE" }).message, /retry the upload/);
  assert.match(getSafeUploadError({ code: "UPLOAD_OBJECT_CHANGED" }).message, /Retry the upload/);
  const { readFile } = await import("node:fs/promises");
  const catalog = JSON.parse(await readFile(new URL("../i18n/zh-CN.json", import.meta.url), "utf8"));
  for (const code of ["UPLOAD_CONTENT_REJECTED", "UPLOAD_SCAN_UNAVAILABLE", "UPLOAD_OBJECT_CHANGED"]) {
    assert.ok(Object.hasOwn(catalog, getSafeUploadError({ code }).message), code);
  }
});
