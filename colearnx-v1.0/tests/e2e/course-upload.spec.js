import { expect as baseExpect, test } from "@playwright/test";
import { mockVideoApi } from "./video.fixture.js";
import { TrainerVideoPage } from "./video.pages.js";

// Windows WebKit's intercepted API requests are slower than Chromium's.
// Wait for user-visible state rather than depending on a fixed delay.
const expect = baseExpect.configure({ timeout: 20000 });
test.describe.configure({ timeout: 60000 });

async function dropFiles(page, files) {
  const dataTransfer = await page.evaluateHandle(entries => {
    const transfer = new DataTransfer();
    for (const entry of entries) transfer.items.add(new File([entry.content || "fixture-video"], entry.name, { type: entry.type, lastModified: 123 }));
    return transfer;
  }, files);
  await page.locator(".course-upload-picker .upload-zone").dispatchEvent("drop", { dataTransfer });
  await dataTransfer.dispose();
}

test("video draft has one lower upload entry and uses it for the required main video", async ({ page }, testInfo) => {
  const state = await mockVideoApi(page), trainer = new TrainerVideoPage(page);
  await trainer.open("course");
  await expect(page.getByRole("heading", { name: "Main course video", exact: true })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Course video upload", exact: true }).locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Optional attachments", exact: true })).toHaveCount(0);
  await expect(page.getByText(/PDF, DOCX, ZIP/)).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveAttribute("accept", "video/*,.mp4,.mov,.m4v,.webm,.mkv");
  await expect(trainer.submitButton()).toBeDisabled();
  await page.getByRole("region", { name: "Course files", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("single-video-uploader-desktop.png"), fullPage: true });

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByText("Choose video", { exact: true }).click();
  const chooser = await chooserPromise;
  expect(chooser.isMultiple()).toBe(false);
  await chooser.setFiles({ name: "lesson.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(1024, 1) });
  await expect(page.getByText("Queued for processing", { exact: true })).toBeVisible();
  expect(state.calls.filter(c => c.path === "/courses/course/video-upload-intents")).toHaveLength(1);
  expect(state.calls.filter(c => c.path === "/courses/course/upload-intents")).toHaveLength(0);
  await expect(trainer.submitButton()).toBeDisabled();

  state.status = "ready";
  await trainer.refreshVideo();
  await expect(trainer.submitButton()).toBeEnabled();
  await trainer.submitButton().click();
  await expect(page.getByRole("button", { name: "Submitted for review", exact: true })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toBeDisabled();
  expect(state.submitted).toBe(true);
  await dropFiles(page, [{ name: "after-review.mp4", type: "video/mp4" }]);
  expect(state.calls.filter(c => c.path === "/courses/course/video-upload-intents")).toHaveLength(1);
});

test("a deletion-pending old version does not introduce a second upload entry", async ({ page }) => {
  const state = await mockVideoApi(page), trainer = new TrainerVideoPage(page);
  state.status = "delete_pending";
  await page.route("**/api/v1/courses/course/video", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
    canUpload: state.status === "delete_pending", canSubmit: false,
    versions: [{ id: "deleted-old", versionNo: 1, status: "delete_pending" },
      ...(state.status === "delete_pending" ? [] : [{ id: "new-version", versionNo: 2, status: state.status }])],
  } }) }));
  await trainer.open("course");
  await expect(page.getByText("Deletion pending", { exact: true })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(1);
  const input = page.getByLabel("Choose course video", { exact: true });
  await expect(input).toBeEnabled();
  await input.setInputFiles({ name: "new.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(1024, 1) });
  await expect(page.getByText("Queued for processing", { exact: true })).toBeVisible();
  await expect(page.getByText("Deletion pending", { exact: true })).toBeVisible();
  await expect(trainer.submitButton()).toBeDisabled();
});

test("non-video selections, non-video drops and empty videos never create an upload", async ({ page }) => {
  const state = await mockVideoApi(page), trainer = new TrainerVideoPage(page);
  await trainer.open("course");
  const input = page.getByLabel("Choose course video", { exact: true });
  await expect(input).toBeEnabled();
  for (const file of [
    { name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a video") },
    { name: "empty.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(0) },
  ]) {
    // Bypass the OS file filter to verify that selection is validated as well.
    await input.setInputFiles(file);
    await expect(page.getByRole("alert")).toHaveText("Video courses only accept non-empty video files. Choose a video file.");
  }
  await dropFiles(page, [{ name: "image.png", type: "image/png" }]);
  await expect(page.getByRole("alert")).toHaveText("Video courses only accept non-empty video files. Choose a video file.");
  expect(state.calls.filter(c => c.method === "POST" && c.path.includes("upload-intents"))).toHaveLength(0);
  await expect(trainer.submitButton()).toBeDisabled();
});

test("dropping multiple videos is rejected without silently selecting one; a single video recovers", async ({ page }) => {
  const state = await mockVideoApi(page), trainer = new TrainerVideoPage(page);
  await trainer.open("course");
  await expect(page.getByLabel("Choose course video", { exact: true })).toBeEnabled();
  await dropFiles(page, [{ name: "one.mp4", type: "video/mp4" }, { name: "two.mp4", type: "video/mp4" }]);
  await expect(page.getByRole("alert")).toHaveText("Choose one main course video at a time.");
  expect(state.calls.filter(c => c.method === "POST" && c.path.includes("upload-intents"))).toHaveLength(0);
  await dropFiles(page, [{ name: "one.mp4", type: "video/mp4" }]);
  await expect(page.getByText("Queued for processing", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(1);
  await expect(page.locator('input[type="file"]')).toBeDisabled();
});

test("interrupted main video resumes through the same lower entry after reloading", async ({ page }) => {
  const state = await mockVideoApi(page), trainer = new TrainerVideoPage(page);
  let failParts = true;
  await page.route("https://fixture.r2.cloudflarestorage.com/part-*", route => failParts && route.request().method() === "PUT" ? route.abort("failed") : route.fallback());
  await trainer.open("course");
  await expect(page.getByLabel("Choose course video", { exact: true })).toBeEnabled();
  await dropFiles(page, [{ name: "original.mp4", type: "video/mp4" }]);
  await expect(page.getByRole("alert")).toHaveText("The video service is unavailable. Check your connection and retry.", { timeout: 20000 });
  await expect(page.getByRole("button", { name: "Resume upload", exact: true })).toBeEnabled();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("colearnx-video-upload:test-account:course")));
  expect(saved.versionId).toBe("new-version");
  await page.reload();
  const input = page.getByLabel("Choose original video to resume", { exact: true });
  await expect(input).toBeEnabled();
  await expect(page.locator('input[type="file"]')).toHaveCount(1);
  await expect(page.getByText("Select the exact original video to resume the paused upload.")).toBeVisible();
  failParts = false;
  await dropFiles(page, [{ name: "original.mp4", type: "video/mp4" }]);
  await expect(page.getByText("Queued for processing", { exact: true })).toBeVisible({ timeout: 20000 });
  expect(state.calls.filter(c => c.path === "/courses/course/video-upload-intents")).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem("colearnx-video-upload:test-account:course"))).toBeNull();
});

test("replacement from the lower entry still requires confirmation and protects purchased versions", async ({ page }) => {
  const state = await mockVideoApi(page), trainer = new TrainerVideoPage(page);
  state.status = "ready";
  await page.route("**/api/v1/courses/course/video", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
    canUpload: state.status === "ready", canSubmit: state.status === "ready", reviewVersionId: "purchased-old",
    versions: [{ id: "purchased-old", versionNo: 1, status: "ready", durationSeconds: 100, canDelete: true, hasOrderReferences: true },
      ...(state.status === "ready" ? [] : [{ id: "new-version", versionNo: 2, status: state.status }])],
  } }) }));
  await trainer.open("course");
  const input = page.getByLabel("Choose course video", { exact: true });
  await expect(input).toBeEnabled();
  await input.setInputFiles({ name: "replacement.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(1024, 1) });
  await expect(page.getByRole("dialog", { name: "Replace course video" })).toBeVisible();
  expect(state.calls.filter(c => c.path === "/courses/course/video-upload-intents")).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Delete unused version" })).toHaveCount(0);
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await input.setInputFiles({ name: "replacement.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(1024, 1) });
  await page.getByRole("button", { name: "Upload new version", exact: true }).click();
  await expect(page.getByText("Queued for processing", { exact: true })).toBeVisible();
  expect(state.calls.filter(c => c.path === "/courses/course/video-upload-intents")).toHaveLength(1);
  await expect(trainer.submitButton()).toBeDisabled();
});

test("mobile lower upload entry is keyboard-accessible and does not overflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockVideoApi(page);
  await new TrainerVideoPage(page).open("course");
  const input = page.getByLabel("Choose course video", { exact: true });
  await expect(input).toBeEnabled();
  await input.focus();
  await expect(input).toBeFocused();
  const chooserPromise = page.waitForEvent("filechooser");
  await input.press("Enter");
  const chooser = await chooserPromise;
  expect(chooser.isMultiple()).toBe(false);
  await chooser.setFiles([]);
  await expect(page.locator('input[type="file"]')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("region", { name: "Course files", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("single-video-uploader-mobile.png"), fullPage: true });
});
