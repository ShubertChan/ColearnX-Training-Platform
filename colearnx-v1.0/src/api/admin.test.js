import assert from "node:assert/strict";
import test from "node:test";
import { apiClient } from "./client.js";
import { previewContentSubmission } from "./admin.js";
import { registerStepUpHandler } from "./stepUp.js";

test("admin preview selects the requested attachment", async () => {
  const originalPost = apiClient.post;
  const unregister = registerStepUpHandler(async () => ({ stepUpToken: "test-proof", expiresInSeconds: 300 }));
  let request;
  apiClient.post = async (url, body, config) => {
    assert.equal(config.headers["X-Step-Up-Token"], "test-proof");
    request = { url, body };
    return { data: { data: { previewUrl: "https://temporary-preview.example" } } };
  };

  try {
    const result = await previewContentSubmission("version-1", "asset-2");
    assert.deepEqual(request, {
      url: "/admin/content-versions/version-1/preview-url",
      body: { assetId: "asset-2" },
    });
    assert.equal(result.previewUrl, "https://temporary-preview.example");
  } finally {
    unregister();
    apiClient.post = originalPost;
  }
});
