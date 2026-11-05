import { expect, test } from "@playwright/test";
import { mockVideoApi } from "./video.fixture.js";

const longDescription = "Learn practical design through clear examples, guided exercises and real projects. ".repeat(24) + "Final project: publish your portfolio.";
async function openMarketplace(page, { language = "en", resource = false } = {}) {
  await mockVideoApi(page, "member");
  await page.route(`**/api/v1/${resource ? "content" : "courses"}?**`, route => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ data: [
      { id: "preview-long", title: "Design foundations", description: longDescription, pricePoints: 100,
        status: "published", category: "Design", type: "PDF", deliveryModes: ["cloud"], onlineVideo: true, owner: { displayName: "Alex" } },
      { id: "preview-short", title: "Short workshop", description: "A short introduction.", pricePoints: 50,
        status: "published", category: "Design", type: "PDF", deliveryModes: ["cloud"], owner: { displayName: "Alex" } },
    ] }),
  }));
  await page.goto(`/#/${resource ? "contents" : "courses"}`);
  await page.locator(".language-switcher select").selectOption(language);
  const card = page.locator(resource ? ".content-card" : ".market-card").filter({ has: page.getByRole("heading", { name: "Design foundations", exact: true }) });
  await expect(card).toBeVisible();
  return { card, preview: card.locator(".marketplace-description"), panel: card.getByRole("region", { name: language === "en" ? "Full description" : "完整简介", exact: true }) };
}

for (const resource of [false, true]) for (const language of ["en", "zh-CN"]) {
  test(`${language} ${resource ? "resource" : "course"} description rises on hover without moving cards`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const { card, preview, panel } = await openMarketplace(page, { language, resource });
    const toggle = card.getByRole("button", { name: language === "en" ? "Read full description" : "查看完整简介", exact: true });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const other = page.locator(resource ? ".content-card" : ".market-card").filter({ has: page.getByRole("heading", { name: "Short workshop", exact: true }) });
    await expect(other.locator(".marketplace-description-toggle")).toHaveCount(0);
    const otherBefore = await other.boundingBox();
    const footerBefore = await card.locator(".market-card-footer").boundingBox();
    await preview.hover();
    await expect(panel).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(panel).toHaveText(longDescription);
    await expect.poll(async () => (await panel.boundingBox()).y < (await preview.boundingBox()).y).toBe(true);
    expect(await other.boundingBox()).toEqual(otherBefore);
    expect(Math.abs((await card.locator(".market-card-footer").boundingBox()).y - footerBefore.y)).toBeLessThanOrEqual(2);
    expect(await panel.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await panel.hover(); await page.mouse.wheel(0, 2000);
    await expect.poll(() => panel.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await expect(panel).toHaveCSS("opacity", "1");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`marketplace-${resource ? "resources" : "courses"}-${language}.png`), fullPage: true });
    await page.locator(".topbar h1").hover();
    await expect(panel).toBeHidden();
    await card.getByRole("link", { name: language === "en" ? "View" : "查看", exact: false }).click();
    await expect(page).toHaveURL(new RegExp(`/${resource ? "contents" : "courses"}/preview-long$`));
    expect(errors).toEqual([]);
  });
}

for (const width of [390, 1024, 1440]) {
  test(`course search is usable without the empty outer frame at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await openMarketplace(page);
    const search = page.getByRole("textbox", { name: "Search published courses", exact: true });
    await expect(page.locator(".course-market-toolbar > .search-field")).toHaveCount(0);
    expect((await search.boundingBox()).width).toBeGreaterThan(180);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await search.fill("Short workshop");
    await expect(page).toHaveURL(/q=Short\+workshop/);
    await expect(page.locator(".market-card")).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Short workshop", exact: true })).toBeVisible();
    await search.clear(); await expect(page.locator(".market-card")).toHaveCount(2);
  });
}

test("keyboard readers can expand and dismiss the description, including after switching language", async ({ page }) => {
  const { card, panel } = await openMarketplace(page);
  const toggle = card.getByRole("button", { name: "Read full description", exact: true });
  await toggle.focus(); await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  await page.keyboard.press("Tab"); await expect(panel).toBeFocused();
  await page.keyboard.press("Escape"); await expect(panel).toBeHidden(); await expect(toggle).toBeFocused();
  await page.keyboard.press("Space"); await expect(panel).toBeVisible();
  await page.locator(".language-switcher select").selectOption("zh-CN");
  const chinesePanel = card.getByRole("region", { name: "完整简介", exact: true });
  await expect(chinesePanel).toBeVisible();
  await card.getByRole("button", { name: "查看完整简介", exact: true }).focus();
  await page.keyboard.press("Escape"); await expect(chinesePanel).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(chinesePanel).toBeVisible();
});

for (const resource of [false, true]) test(`touch can toggle a long ${resource ? "resource" : "course"} description without hover or horizontal overflow`, async ({ browser }) => {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 390, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  try {
    const { card, panel } = await openMarketplace(page, { resource });
    const toggle = card.getByRole("button", { name: "Read full description", exact: true });
    await toggle.tap(); await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS("opacity", "1");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`marketplace-${resource ? "resources" : "courses"}-mobile.png`), fullPage: true });
    await toggle.tap(); await expect(panel).toBeHidden();
    await toggle.tap(); await expect(panel).toBeVisible();
    await card.getByRole("link", { name: "View", exact: false }).tap();
    await expect(page).toHaveURL(new RegExp(`/${resource ? "contents" : "courses"}/preview-long$`));
  } finally { await context.close(); }
});
