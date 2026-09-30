import { test, expect } from "@playwright/test";
import { mockVideoApi } from "./video.fixture.js";

// Exercise the production UI and real XHR/Axios failures, with only external
// API/storage boundaries intercepted. No live account or private file is used.
async function openUploader(page, kind, scenario) {
  await mockVideoApi(page, kind === "content" ? "creator" : "trainer");
  const base = kind === "content" ? "/content-versions/version" : "/courses/course";
  const state = { reservations: new Map(), puts: 0, deletes: 0, uploaded: false, ready: false, lost: false };
  const file = { name: "lesson.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(1024) };
  const asset = () => ({ assetId: "asset", filename: file.name, mediaType: file.mimeType, sizeBytes: file.buffer.length, status: state.ready ? "ready" : "pending", assetPurpose: "cloud_download" });
  const reply = (route, data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ data }) });
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (kind === "content" && path === "/content" && request.method() === "POST") {
      return reply(route, { id: "content", contentVersionId: "version" }, 201);
    }
    if (path === `${base}/assets`) return reply(route, { assets: [] });
    if (path === `${base}/upload-intents`) {
      const key = request.headers()["idempotency-key"];
      if (!key) throw new Error("Missing upload reservation key");
      state.reservations.set(key, request.postDataJSON().sizeBytes);
      if (scenario === "intent-response-lost" && !state.lost) { state.lost = true; return route.abort("failed"); }
      if (state.ready) return reply(route, asset());
      return reply(route, { assetId: "asset", uploadUrl: "https://fixture.r2.cloudflarestorage.com/private-upload/asset", requiredHeaders: { "Content-Type": file.mimeType } }, 201);
    }
    if (path === `${base}/upload-intents/asset/complete`) {
      if (!state.uploaded) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "UPLOAD_OBJECT_NOT_FOUND", message: "The file has not reached storage. Retry the upload." } }) });
      state.ready = true;
      if (scenario === "confirmation-response-lost" && !state.lost) { state.lost = true; return route.abort("failed"); }
      return reply(route, asset());
    }
    if (path === `${base}/upload-intents/asset` && request.method() === "DELETE") { state.deletes++; return reply(route, {}); }
    return route.fallback();
  });
  await page.route("https://fixture.r2.cloudflarestorage.com/private-upload/**", async route => {
    if (route.request().method() === "PUT") {
      state.puts++;
      if (scenario === "repeated-interruptions" && state.puts <= 6) return route.abort("failed");
      state.uploaded = true;
      if (scenario === "put-response-lost" && !state.lost) { state.lost = true; return route.abort("failed"); }
    }
    return route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "PUT, OPTIONS", "Access-Control-Allow-Headers": "*" }, body: "" });
  });
  await page.goto(kind === "content" ? "/#/creator/content-editor" : "/#/trainer/course-editor?draft=course");
  const uploader = page.getByRole("region", { name: kind === "content" ? "Content files" : "Course attachments" });
  if (kind === "content") {
    await page.getByLabel("Content title").fill("Network retry lesson");
    await page.getByLabel("Public description").fill("Test private file upload retries.");
    await page.getByLabel("Price in points").fill("100");
    await page.getByRole("button", { name: "Create content", exact: true }).click();
  }
  const input = uploader.getByLabel(kind === "content" ? "Choose content files" : "Choose course attachments");
  await expect(input).toBeEnabled();
  await input.setInputFiles(file);
  return { state, uploader, file };
}

for (const kind of ["content", "course"]) {
  test(`${kind}: six interrupted uploads can be retried without consuming six reservations`, async ({ page }) => {
    const { state, uploader, file } = await openUploader(page, kind, "repeated-interruptions");
    for (let attempt = 0; attempt < 6; attempt++) {
      await expect(uploader.getByText("The network connection was interrupted during upload.")).toBeVisible();
      expect(state.puts).toBe(attempt + 1);
      expect([...state.reservations.values()].reduce((sum, size) => sum + size, 0)).toBe(file.buffer.length);
      await expect(uploader.getByRole("progressbar")).toHaveCount(0);
      await uploader.getByRole("button", { name: "Retry lesson.mp4" }).click();
    }
    await expect(uploader.getByText("Uploaded", { exact: true })).toBeVisible();
    expect(state.puts).toBe(7);
    expect(state.deletes).toBe(0);
    await expect(uploader.getByText(/Your storage limit/)).toHaveCount(0);
    if (kind === "content") {
      await expect(page.getByRole("button", { name: "Submit for administrator review" })).toBeEnabled();
      await page.screenshot({ path: "test-results/upload-retry-content.png", fullPage: true });
    }
  });

  for (const scenario of ["intent-response-lost", "put-response-lost", "confirmation-response-lost"]) {
    test(`${kind}: ${scenario} recovers with one reservation and one file upload`, async ({ page }) => {
      const { state, uploader } = await openUploader(page, kind, scenario);
      await expect(uploader.getByRole("button", { name: "Retry lesson.mp4" })).toBeVisible();
      await uploader.getByRole("button", { name: "Retry lesson.mp4" }).click();
      await expect(uploader.getByText("Uploaded", { exact: true })).toBeVisible();
      expect(state.reservations.size).toBe(1);
      expect(state.puts).toBe(1);
      expect(state.deletes).toBe(0);
    });
  }
}
