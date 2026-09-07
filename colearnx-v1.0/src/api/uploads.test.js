import assert from "node:assert/strict";
import test from "node:test";
import { apiClient } from "./client.js";
import { listContentAssets, requestContentDownloadUrl } from "./uploads.js";

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