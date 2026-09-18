import { expect, test } from "@playwright/test";
import { mockVideoApi } from "./video.fixture";
import { TrainerVideoPage, LearnerVideoPage, AdminVideoPage } from "./video.pages";
import { readFile } from "node:fs/promises";

test("ready video cannot bypass an unavailable attachment inventory", async ({ page }) => {
  const state = await mockVideoApi(page); state.status = "ready"; state.attachmentError = true;
  const trainer = new TrainerVideoPage(page); await trainer.open("course");
  await expect(page.getByRole("button", { name: "Refresh video status" })).toBeEnabled();
  await expect(trainer.submitButton()).toBeDisabled();
});

test("delisted purchased video retains refund access and does not resubmit after refresh failure", async ({ page }) => {
  const state = await mockVideoApi(page, "member"); state.catalogueVisible = false;
  await page.goto("/#/purchases");
  await page.getByRole("link", { name: "Request refund", exact: true }).click();
  await expect(page).toHaveURL(/refund\/course\?orderItem=order-item/);
  await expect(page.getByText("Full order-item points refund available.")).toBeVisible();
  await page.getByLabel("Reason for request").fill("I would like to return this course");
  state.orderRefreshFails = true;
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await expect(page).toHaveURL(/#\/orders$/);
  const requests = state.calls.filter(c => c.path === "/refund-requests" && c.method === "POST");
  expect(requests).toHaveLength(1);
  expect(requests[0].input.orderItemId).toBe("order-item");
  expect(requests[0].requestKey).toBeTruthy();
});

test("real HLS decodes, seeks and renews without losing position or reporting watched totals", async ({ page }, testInfo) => {
  const supportsMse = await page.evaluate(() => Boolean(window.MediaSource?.isTypeSupported('video/mp4; codecs="avc1.42E01E"')));
  test.skip(!supportsMse, "This browser build has no H.264 MediaSource support; header-authorized HLS cannot decode here. Real Safari/native-cookie playback remains a release gate.");
  const state = await mockVideoApi(page, "member"); state.playback = true; state.duration = 14; state.ttl = 6000;
  const mediaRequests = [], errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/fixture-media/**", async route => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1);
    expect(["master.m3u8", "init.mp4", "segment.m4s"]).toContain(name);
    mediaRequests.push({ name, authorization: route.request().headers().authorization });
    await route.fulfill({ status: 200, contentType: name.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4", body: await readFile(new URL(`../fixtures/hls/${name}`, import.meta.url)) });
  });
  const learner = new LearnerVideoPage(page); await learner.open();
  const video = page.getByLabel("Course video", { exact: true });
  await video.evaluate(media => {
    window.__playbackEvents = [];
    for (const type of ["seeking", "seeked", "waiting", "playing", "pause", "loadedmetadata"]) {
      media.addEventListener(type, () => window.__playbackEvents.push({ type, position: media.currentTime, at: performance.now() }));
    }
  });
  await expect(page.getByRole("button", { name: "Sync viewing progress" })).toBeVisible();
  try {
    await video.evaluate(media => media.play());
    await expect.poll(() => video.evaluate(media => media.currentTime)).toBeGreaterThan(1.5);
    await learner.seekTo(7);
    await expect.poll(() => state.calls.filter(c => c.path.endsWith("/progress") && c.input.event === "seeked").map(c => c.input.positionSeconds)).toEqual(expect.arrayContaining([expect.closeTo(7, 1)]));
  } catch (error) {
    await testInfo.attach("playback-diagnostics", { contentType: "application/json", body: JSON.stringify({
      sessions: state.sessions,
      heartbeats: state.calls.filter(c => c.path.endsWith("/progress")).map(c => c.input),
      media: await video.evaluate(media => ({ position: media.currentTime, paused: media.paused, readyState: media.readyState, events: window.__playbackEvents })),
    }, null, 2) });
    throw error;
  }
  await expect.poll(() => state.sessions, { timeout: 10000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate(media => media.currentTime)).toBeGreaterThan(7);
  await expect.poll(() => mediaRequests.some(r => r.authorization === "Bearer media-token-2" && r.name === "segment.m4s")).toBe(true);
  await learner.pause();
  expect(mediaRequests.some(r => r.name === "init.mp4")).toBe(true);
  expect(mediaRequests.every(r => /^Bearer media-token-\d+$/.test(r.authorization))).toBe(true);
  for (const call of state.calls.filter(c => c.path.endsWith("/progress"))) {
    expect(Object.keys(call.input).sort()).toEqual(["sessionId", "sequence", "event", "positionSeconds", "playbackRate", "clientMonotonicMs"].sort());
  }
  expect(errors).toEqual([]);
});

test("unsupported media capability shows a clear error without fetching unprotected video", async ({ page }) => {
  const state = await mockVideoApi(page, "member"); state.playback = true;
  await page.addInitScript(() => {
    Object.defineProperty(window, "MediaSource", { value: undefined, configurable: true });
    Object.defineProperty(window, "ManagedMediaSource", { value: undefined, configurable: true });
    HTMLMediaElement.prototype.canPlayType = () => "";
  });
  const mediaRequests = [];
  page.on("request", request => { if (request.url().includes("/fixture-media/")) mediaRequests.push(request.url()); });
  await new LearnerVideoPage(page).open();
  await expect(page.getByText("This browser cannot play this video. Try a browser with HLS support.")).toBeVisible();
  expect(mediaRequests).toEqual([]);
});

test("trainer uploads parts and can submit only after verified readiness", async ({ page }) => {
  const state = await mockVideoApi(page), trainer = new TrainerVideoPage(page);
  await trainer.open("course");
  await expect(trainer.submitButton()).toBeDisabled();
  await expect(page.getByLabel(/Video duration in seconds/)).toHaveCount(0);
  await trainer.upload({ name: "fixture.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(6 * 1024 * 1024, 1) });
  await expect(page.getByText("Queued for processing", { exact: true })).toBeVisible();
  await expect(trainer.submitButton()).toBeDisabled();
  expect(state.calls.filter(c => c.method === "PUT").map(c => c.path)).toEqual(["/part-1", "/part-2"]);
  state.status = "ready"; await trainer.refreshVideo();
  await expect(trainer.submitButton()).toBeEnabled();
  await trainer.submitButton().click();
  await expect(page.getByRole("button", { name: "Submitted for review", exact: true })).toBeVisible();
  expect(state.submitted).toBe(true);
});
test("learner requests purchased-version authorization and never exposes source downloads", async ({ page }) => {
  const state = await mockVideoApi(page, "member"), learner = new LearnerVideoPage(page);
  await learner.open();
  await expect(page.getByText("This video is unavailable for this account or purchase.")).toBeVisible();
  await expect(page.getByText("notes.pdf", { exact: true })).toBeVisible();
  await expect(page.getByText("source.mp4", { exact: true })).toHaveCount(0);
  expect(state.calls.some(c => c.path === "/order-items/order-item/playback-sessions")).toBe(true);
  expect(state.calls.some(c => c.path === "/courses/course/video")).toBe(false);
});
test("mobile refund shows server rejection even when displayed progress rounds to 10 percent", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await mockVideoApi(page, "member"); state.ratio = 0.1000001; state.eligible = false;
  const learner = new LearnerVideoPage(page); await learner.openRefund("course");
  await expect(page.getByText("WATCH_LIMIT_EXCEEDED", { exact: true })).toBeVisible();
  await expect(page.getByText("Not eligible", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit for review", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("admin preview rejects unavailable authorization without enabling approval", async ({ page }) => {
  const state = await mockVideoApi(page, "admin"); state.status = "ready";
  const admin = new AdminVideoPage(page); await admin.open();
  await page.getByLabel("Decision reason", { exact: true }).fill("Reviewed video metadata");
  await expect(admin.approveButton()).toBeDisabled();
  await admin.preview();
  await expect(page.getByText("This video is unavailable for this account or purchase.")).toBeVisible();
  await expect(admin.approveButton()).toBeDisabled();
  expect(state.calls.some(c => c.path === "/admin/course-runs/course/video-versions/new-version/playback-sessions")).toBe(true);
});
