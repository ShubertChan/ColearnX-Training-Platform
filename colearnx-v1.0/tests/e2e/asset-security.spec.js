import { test, expect } from "@playwright/test";

test("the browser refuses a changed application entry before running it", async ({ page }) => {
  let served = false;
  await page.route("**/assets/index-*.js", async route => {
    served = true;
    await route.fulfill({ contentType: "text/javascript", body: "globalThis.alteredEntryRan = true;" });
  });
  await page.goto("/");
  expect(served).toBe(true);
  await expect(page.locator("#root")).toBeEmpty();
  expect(await page.evaluate(() => globalThis.alteredEntryRan)).toBeUndefined();
});

test("the deployed policy blocks injected styles and altered lazy modules", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "The integrity member of import maps requires browser support.");
  await page.goto("/");
  await expect(page.locator("#root")).not.toBeEmpty();
  const src = await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = "html { --injected-security-test: blocked; }";
    document.head.append(style);
    if (getComputedStyle(document.documentElement).getPropertyValue("--injected-security-test")) throw Error("Inline CSS applied");
    const map = JSON.parse(document.querySelector('script[type="importmap"]').textContent);
    return Object.keys(map.integrity).find(name => name.includes("/hls-"));
  });
  expect(src).toBeTruthy();
  await page.route("**/assets/hls-*.js", route => route.fulfill({
    contentType: "text/javascript", body: "globalThis.alteredModuleRan = true; export default {};",
  }));
  const result = await page.evaluate(async (src) => {
    try { await import(new URL(src, document.baseURI).href); return "executed"; } catch { return "rejected"; }
  }, src);
  expect(result).toBe("rejected");
  expect(await page.evaluate(() => globalThis.alteredModuleRan)).toBeUndefined();
});
