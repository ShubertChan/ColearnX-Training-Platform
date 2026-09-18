import test from "node:test";
import assert from "node:assert/strict";
import { videoHeaders } from "../../build/videoHeaders.js";
test("video switch off leaves existing attachment deployments unchanged", () => assert.equal(videoHeaders({}), null));
test("video CSP permits exact API/media/R2 origins, HLS workers and no referrer leakage", () => {
  const headers = videoHeaders({ VITE_ENABLE_HOSTED_VIDEO: "true", VITE_API_BASE_URL: "https://api.example/api/v1", VITE_MEDIA_ORIGINS: "https://media.example", VITE_UPLOAD_ORIGINS: "https://account.r2.cloudflarestorage.com" });
  assert.match(headers, /connect-src 'self' https:\/\/api.example https:\/\/media.example https:\/\/account.r2.cloudflarestorage.com/);
  assert.match(headers, /worker-src 'self' blob:/); assert.match(headers, /Referrer-Policy: no-referrer/);
  assert.throws(() => videoHeaders({ VITE_ENABLE_HOSTED_VIDEO: "true", VITE_UPLOAD_ORIGINS: "https://example.com/path" }));
});
