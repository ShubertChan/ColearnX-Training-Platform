import { expect, test } from "@playwright/test";
import { mockVideoApi } from "./video.fixture.js";

test.use({ timezoneId: "Asia/Singapore" });
const switchLanguage = (page, language) => page.locator(".language-switcher select").selectOption(language);
const pickerFor = field => field.locator("..").getByRole("button");

for (const width of [390, 1440]) for (const language of ["en", "zh-CN"]) {
  test(`${language} date filter and calendar fit ${width}px and preserve ISO dates`, async ({ page }, testInfo) => {
    await mockVideoApi(page, "member");
    await page.setViewportSize({ width, height: 1000 });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto("/#/courses"); await switchLanguage(page, language);
    const zh = language === "zh-CN";
    const field = page.getByLabel(zh ? "开始日期不早于" : "Starts on or after", { exact: true });
    await expect(field).toHaveAttribute("placeholder", zh ? "年-月-日" : "YYYY-MM-DD");
    await field.fill("2026-10-23"); await pickerFor(field).click();
    const dialog = page.getByRole("dialog", { name: zh ? "选择日期" : "Choose date" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(zh ? "日历月份" : "Calendar month")).toHaveValue("10");
    const weekdays = await dialog.locator(".calendar-weekdays").textContent();
    expect(weekdays).toContain(zh ? "周一" : "Mon");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`calendar-${language}-${width}.png`), fullPage: true });
    await dialog.locator('[data-date="2026-10-29"]').click();
    await dialog.getByRole("button", { name: zh ? "确认日期" : "Apply date", exact: true }).click();
    await expect(field).toHaveValue("2026-10-29");
    await expect(page).toHaveURL(/date=2026-10-29/);
    await switchLanguage(page, zh ? "en" : "zh-CN");
    await expect(page.getByLabel(zh ? "Starts on or after" : "开始日期不早于", { exact: true })).toHaveValue("2026-10-29");
    await page.reload();
    const restored = page.getByLabel(zh ? "Starts on or after" : "开始日期不早于", { exact: true });
    await expect(restored).toHaveValue("2026-10-29");
    await pickerFor(restored).click();
    await page.getByRole("button", { name: zh ? "Clear date" : "清除日期", exact: true }).click();
    await expect(restored).toHaveValue(""); await expect(page).not.toHaveURL(/date=/);
    expect(errors).toEqual([]);
  });
}

test("course calendar rejects invalid dates and submits the chosen local time as the correct UTC timestamp", async ({ page }) => {
  const state = await mockVideoApi(page, "trainer");
  await page.goto("/#/trainer/course-editor");
  await page.getByLabel("Course title").fill("Calendar regression course");
  await page.getByLabel("Public description").fill("Test date and timezone preservation.");
  await page.getByLabel("Price in points").fill("20");
  const start = page.getByLabel("Start time (required)", { exact: true });
  await start.fill("2026-02-30 14:30");
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  expect(state.calls.filter(call => call.path === "/courses" && call.method === "POST")).toHaveLength(0);
  expect(await start.evaluate(input => input.validity.valid)).toBe(false);
  await start.fill("2028-02-29 14:30");
  await pickerFor(start).click();
  const dialog = page.getByRole("dialog", { name: "Choose date and time" });
  await expect(dialog.locator('[data-date="2028-02-29"]')).toBeEnabled();
  await dialog.getByLabel("Time (24-hour)").fill("15:45");
  await dialog.getByRole("button", { name: "Apply date", exact: true }).click();
  expect(state.calls.filter(call => call.path === "/courses" && call.method === "POST")).toHaveLength(0);
  await switchLanguage(page, "zh-CN");
  await expect(page.getByLabel("开始时间（必填）", { exact: true })).toHaveValue("2028-02-29 15:45");
  await page.getByRole("button", { name: "创建草稿", exact: true }).click();
  await expect.poll(() => state.calls.filter(call => call.path === "/courses" && call.method === "POST").length).toBe(1);
  const input = state.calls.find(call => call.path === "/courses" && call.method === "POST").input;
  expect(input.startsAt).toBe("2028-02-29T07:45:00.000Z");
  expect(input.timezone).toBe("Asia/Singapore");
});

test("administration date ranges reject out-of-range input and localize both endpoints", async ({ page }) => {
  await mockVideoApi(page, "admin");
  const ranges = [];
  await page.route("**/api/v1/admin/activity-report**", route => {
    ranges.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: { data: { activeUsers: 0, orders: 0, reports: 0, items: [] } } });
  });
  await page.goto("/#/admin/operations");
  await page.getByRole("button", { name: "Activity report", exact: true }).click();
  const from = page.getByLabel("From date", { exact: true }), to = page.getByLabel("To date", { exact: true });
  await from.fill("2026-10-20"); await to.fill("2026-10-25");
  const calls = () => ranges.length;
  await expect.poll(() => ranges.at(-1)?.get("to")).toBe("2026-10-25");
  const before = calls();
  await from.fill("2026-10-26"); await from.blur();
  await expect(page.locator(".date-input-error")).toHaveText("Choose 2026-10-25 or earlier.");
  expect(calls()).toBe(before);
  await pickerFor(from).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator('[data-date="2026-10-26"]')).toBeDisabled();
  await dialog.locator('[data-date="2026-10-24"]').click(); await dialog.getByRole("button", { name: "Apply date", exact: true }).click();
  await switchLanguage(page, "zh-CN");
  await expect(page.getByLabel("起始日期", { exact: true })).toHaveValue("2026-10-24");
  await expect(page.getByLabel("截止日期", { exact: true })).toHaveValue("2026-10-25");
});

test("publishing actions cannot save a stale date while the date field contains invalid input", async ({ page }) => {
  const state = await mockVideoApi(page, "trainer");
  await page.goto("/#/publishing-tools");
  await page.getByLabel("Choose a listing").selectOption("course");
  await page.getByLabel("Reason or change summary (at least 5 characters)").fill("Review schedule change");
  const review = page.getByRole("button", { name: "Review metadata update", exact: true });
  await expect(review).toBeEnabled();
  const start = page.getByLabel("Start time (required)", { exact: true });
  await start.fill("2026-02-30 10:00");
  await expect(review).toBeDisabled();
  expect(state.calls.filter(call => call.method === "PATCH")).toHaveLength(0);
  await start.fill("2026-10-24 10:00");
  await expect(review).toBeEnabled();
  await review.click();
  await page.getByRole("button", { name: "Confirm change", exact: true }).click();
  await expect.poll(() => state.calls.filter(call => call.path === "/courses/course" && call.method === "PATCH").length).toBe(1);
  const input = state.calls.find(call => call.path === "/courses/course" && call.method === "PATCH").input;
  expect(input.startsAt).toBe("2026-10-24T02:00:00.000Z");
});
