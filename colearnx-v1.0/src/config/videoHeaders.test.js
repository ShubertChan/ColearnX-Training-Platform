import test from "node:test";
import assert from "node:assert/strict";
import { securityHeaders } from "../../build/videoHeaders.js";

test("a full security header set is always emitted, even with hosted video off", () => {
  const headers = securityHeaders({ VITE_API_BASE_URL: "https://api.example/api/v1" });
  assert.match(headers, /Content-Security-Policy: default-src 'self'/);
  assert.match(headers, /connect-src 'self' https:\/\/api.example/);
  assert.match(headers, /frame-ancestors 'none'/);
  assert.match(headers, /object-src 'none'/);
  assert.match(headers, /form-action 'self'/);
  assert.match(headers, /Strict-Transport-Security: max-age=63072000; includeSubDomains; preload/);
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /X-Frame-Options: DENY/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
  // No unconfigured storage origins are allowed.
  assert.doesNotMatch(headers, /cloudflarestorage/);
});

test("hosted video adds the exact API/media/R2 origins to connect/media and keeps worker-src", () => {
  const headers = securityHeaders({
    VITE_ENABLE_HOSTED_VIDEO: "true",
    VITE_API_BASE_URL: "https://api.example/api/v1",
    VITE_MEDIA_ORIGINS: "https://media.example",
    VITE_UPLOAD_ORIGINS: "https://account.r2.cloudflarestorage.com",
  });
  assert.match(headers, /connect-src 'self' https:\/\/api.example https:\/\/media.example https:\/\/account.r2.cloudflarestorage.com/);
  assert.match(headers, /media-src 'self' blob: https:\/\/media.example/);
  assert.match(headers, /worker-src 'self' blob:/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
});

test("hosted video rejects a non-origin (path) upload value", () => {
  assert.throws(() => securityHeaders({ VITE_ENABLE_HOSTED_VIDEO: "true", VITE_UPLOAD_ORIGINS: "https://example.com/path" }));
});

test("hosted video requires the upload origins to be set", () => {
  assert.throws(() => securityHeaders({ VITE_ENABLE_HOSTED_VIDEO: "true" }));
});

test("attachment uploads stay allowed by exact origin when hosted video is off", () => {
  const headers = securityHeaders({
    VITE_ENABLE_HOSTED_VIDEO: "false",
    VITE_API_BASE_URL: "https://api.example/api/v1",
    VITE_UPLOAD_ORIGINS: "https://account.r2.cloudflarestorage.com",
    VITE_MEDIA_ORIGINS: "https://media.example",
  });
  assert.match(headers, /connect-src 'self' https:\/\/api.example https:\/\/account.r2.cloudflarestorage.com/);
  assert.doesNotMatch(headers, /https:\/\/media.example/);
  assert.doesNotMatch(headers, /connect-src[^;]*\*/);
});

test("upload origins are validated even with hosted video off", () => {
  for (const invalid of ["https://example.com/path", "https://*.example.com", "http://example.com"]) {
    assert.throws(() => securityHeaders({ VITE_ENABLE_HOSTED_VIDEO: "false", VITE_UPLOAD_ORIGINS: invalid }));
  }
});

test("hosted video cannot be built without its playback gateway origin", () => {
  assert.throws(() => securityHeaders({
    VITE_ENABLE_HOSTED_VIDEO: "true",
    VITE_UPLOAD_ORIGINS: "https://account.r2.cloudflarestorage.com",
  }), /VITE_MEDIA_ORIGINS/);
});
