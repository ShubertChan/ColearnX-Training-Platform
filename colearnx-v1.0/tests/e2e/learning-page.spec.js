import { expect as baseExpect, test } from "@playwright/test";
import { mockVideoApi } from "./video.fixture.js";
import { readFile } from "node:fs/promises";
const expect = baseExpect.configure({ timeout: 20000 });
test.describe.configure({ timeout: 60000 });

async function playableFixture(page) {
  const state = await mockVideoApi(page, "member"); state.playback = true; state.duration = 14;
  await page.route("**/fixture-media/**", async route => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1);
    if (!["master.m3u8", "init.mp4", "segment.m4s"].includes(name)) return route.abort();
    await route.fulfill({ contentType: name.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4", body: await readFile(new URL(`../fixtures/hls/${name}`, import.meta.url)) });
  });
  return state;
}

test("My Learning is an entry; the purchased video has a dedicated, refreshable page", async ({ page }, testInfo) => {
  await playableFixture(page);
  await page.goto("/#/purchases");
  await expect(page.getByLabel("Course video", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Watch course", exact: true }).click();
  await expect(page).toHaveURL(/purchases\/order-item\/watch/);
  await expect(page.getByRole("heading", { name: "Recorded design workshop", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to My Learning", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Recorded design workshop", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("learning-desktop.png"), fullPage: true });
  await page.getByRole("link", { name: "Back to My Learning", exact: true }).click();
  await expect(page).toHaveURL(/#\/purchases$/);
});

for (const width of [375, 768, 1024, 1440]) {
  test(`learning page at ${width}px has a large player, keyboard navigation and no overflow`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await playableFixture(page);
    await page.goto("/#/purchases/order-item/watch");
    await expect(page.getByRole("heading", { name: "Recorded design workshop", exact: true })).toBeVisible();
    const player = page.locator(".course-learning-screen");
    await expect(player).toBeVisible();
    const box = await player.boundingBox();
    expect(box.width).toBeGreaterThan(Math.min(300, width - 60));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const back = page.getByRole("link", { name: "Back to My Learning", exact: true });
    await back.focus(); await expect(back).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Refresh course", exact: true })).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`learning-${width}.png`), fullPage: true });
  });
}

test("native video controls play and pause on the dedicated page", async ({ page }) => {
  const state = await playableFixture(page);
  await page.goto("/#/purchases/order-item/watch");
  const supported = await page.evaluate(() => Boolean(window.MediaSource?.isTypeSupported('video/mp4; codecs="avc1.42E01E"')));
  test.skip(!supported, "This browser build has no header-authorized H.264 HLS support.");
  await expect(page.getByRole("button", { name: "Sync viewing progress" })).toBeVisible();
  const video = page.getByLabel("Course video", { exact: true });
  const box = await video.boundingBox();
  await video.hover();
  await video.click({ position: { x: 25, y: box.height - 49 } });
  await expect.poll(() => video.evaluate(media => media.paused)).toBe(false);
  await expect.poll(() => video.evaluate(media => media.currentTime)).toBeGreaterThan(1.5);
  await video.click({ position: { x: 25, y: box.height - 49 } });
  await expect.poll(() => video.evaluate(media => media.paused)).toBe(true);
  expect(state.calls.some(c => c.path.endsWith("/progress") && c.input.event === "playing")).toBe(true);
});

test("before the start time no playback session or video is requested; server refresh unlocks it", async ({ page }) => {
  const state = await mockVideoApi(page, "member"); state.startsAt = "2099-10-01T10:00:00.000Z";
  await page.goto("/#/purchases/order-item/watch");
  await expect(page.getByRole("heading", { name: "Your course opens soon" })).toBeVisible();
  await expect(page.getByLabel("Course video", { exact: true })).toHaveCount(0);
  expect(state.calls.filter(c => c.path.endsWith("/playback-sessions"))).toHaveLength(0);
  state.startsAt = "2026-01-01T00:00:00.000Z";
  await page.getByRole("button", { name: "Refresh course", exact: true }).click();
  await expect(page.getByLabel("Course video", { exact: true })).toHaveCount(1);
  await expect.poll(() => state.calls.filter(c => c.path.endsWith("/playback-sessions")).length).toBe(1);
});

test("legacy video without a start time stays locked with a clear explanation", async ({ page }) => {
  const state = await mockVideoApi(page, "member"); state.missingStart = true;
  await page.goto("/#/purchases/order-item/watch");
  await expect(page.getByRole("heading", { name: "Start time not set" })).toBeVisible();
  await expect(page.getByText(/Trainer needs to set a start time/)).toBeVisible();
  expect(state.calls.filter(c => c.path.endsWith("/playback-sessions"))).toHaveLength(0);
});

test("a denied direct learning URL never requests playback and can retry a delivery error", async ({ page }) => {
  const state = await mockVideoApi(page, "member");
  let unavailable = true;
  await page.route("**/api/v1/order-items/order-item/delivery", async route => {
    if (!unavailable) return route.fallback();
    await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "COURSE_DELIVERY_NOT_FOUND", message: "This purchase is not authorised." } }) });
  });
  await page.goto("/#/purchases/order-item/watch");
  await expect(page.getByRole("heading", { name: "Course unavailable", exact: true })).toBeVisible();
  expect(state.calls.filter(c => c.path.endsWith("/playback-sessions"))).toHaveLength(0);
  unavailable = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator(".course-learning-screen")).toBeVisible();
});

test("Publishing tools save a video draft start time without losing its delivery settings", async ({ page }) => {
  const state = await mockVideoApi(page, "trainer");
  await page.goto("/#/publishing-tools");
  await page.getByLabel("Choose a listing").selectOption("course");
  await page.getByLabel("Start time (required)").fill("2026-10-02T10:00");
  await page.getByLabel("Reason or change summary (at least 5 characters)").fill("Confirm opening time");
  await page.getByRole("button", { name: "Review metadata update", exact: true }).click();
  await page.getByRole("button", { name: "Confirm change", exact: true }).click();
  await expect.poll(() => state.calls.filter(c => c.path === "/courses/course" && c.method === "PATCH").length).toBe(1);
  const input = state.calls.find(c => c.path === "/courses/course" && c.method === "PATCH").input;
  expect(input).toMatchObject({ deliveryModes: ["cloud"], progressTrackingType: "online_video", capacity: 12, categoryId: "fixture-category", timezone: "Asia/Singapore" });
  expect(Date.parse(input.startsAt)).toBeGreaterThan(Date.parse("2026-10-01T00:00:00Z"));
});

test("published start time cannot be edited without review", async ({ page }) => {
  const state = await mockVideoApi(page, "trainer"); state.listingStatus = "published";
  await page.goto("/#/publishing-tools");
  await page.getByLabel("Choose a listing").selectOption("course");
  await expect(page.getByLabel("Start time (required)")).toBeDisabled();
  await expect(page.getByText(/Published course times cannot be changed directly/)).toBeVisible();
});

test("a Trainer must fill a start time before the browser can create a video course", async ({ page }) => {
  const state = await mockVideoApi(page, "trainer");
  await page.goto("/#/trainer/course-editor");
  await page.getByLabel("Course title").fill("New scheduled course");
  await page.getByLabel("Public description").fill("Learn design with one protected video");
  await page.getByLabel("Price in points").fill("20");
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  expect(state.calls.filter(c => c.path === "/courses" && c.method === "POST")).toHaveLength(0);
  await page.getByLabel("Start time (required)").fill("2026-10-02T10:00");
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Course draft", exact: true })).toBeVisible();
  const input = state.calls.find(c => c.path === "/courses" && c.method === "POST").input;
  expect(input.progressTrackingType).toBe("online_video"); expect(input.startsAt).toMatch(/Z$/);
});

test("category choices survive filtering and reset; no synthetic General or empty search wrapper", async ({ page }) => {
  await mockVideoApi(page, "member");
  const resources = [
    { id: "design", title: "Design notes", category: { name: "Design" } },
    { id: "technology", title: "Technology notes", category: { name: "Technology" } },
    { id: "uncategorised", title: "Uncategorised notes" },
  ].map(item => ({ ...item, description: "Resource", contentType: "PDF", pricePoints: 10 }));
  await page.route("**/api/v1/content?**", async route => {
    const category = new URL(route.request().url()).searchParams.get("category");
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: resources.filter(item => !category || item.category?.name === category) }) });
  });
  await page.goto("/#/contents");
  const categories = page.getByLabel("Filter resource category");
  await expect(categories.locator("option")).toHaveText(["All categories", "Design", "Technology"]);
  await categories.selectOption("Design");
  await expect(page.getByRole("link", { name: "Design notes", exact: true })).toBeVisible();
  await expect(categories.locator("option")).toHaveText(["All categories", "Design", "Technology"]);
  await categories.selectOption("");
  await expect(page.getByRole("link", { name: "Uncategorised notes", exact: true })).toBeVisible();
  await page.goto("/#/contents?category=General");
  await expect(categories).toHaveValue("");
  await expect(page).not.toHaveURL(/category=General/);
  await expect(page.getByRole("link", { name: "Uncategorised notes", exact: true })).toBeVisible();
  await expect(page.locator(".content-market-toolbar .search-field")).toHaveCount(0);
  const search = page.getByLabel("Search published resources");
  const box = await search.boundingBox(); expect(box.width).toBeGreaterThan(180);
});
