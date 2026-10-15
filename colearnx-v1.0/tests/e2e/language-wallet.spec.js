import { expect, test } from "@playwright/test";
import { mockVideoApi } from "./video.fixture.js";
const json = data => ({ contentType: "application/json", body: JSON.stringify({ data }) });
async function publishedCourse(page) {
  await page.route("**/api/v1/courses?**", route => route.fulfill(json([{
    id: "available-course", title: "Design foundations", description: "An original English course description.",
    pricePoints: 100, status: "published", deliveryModes: ["cloud"], onlineVideo: true,
    owner: { displayName: "Alex" }, refundPolicyPreview: { summary: "Original purchase policy." },
  }])));
}
for (const width of [375, 768, 1440]) {
  for (const language of ["en", "zh-CN"]) test(`${language} home and course detail fit ${width}px and keep purchase actions working`, async ({ page }) => {
    await mockVideoApi(page, "member"); await publishedCourse(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#/home");
    await page.getByRole("combobox", { name: "Language", exact: true }).selectOption(language);
    await expect(page.getByRole("heading", { name: language === "en" ? "Your learning at a glance" : "您的学习概览", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.goto("/#/courses/available-course");
    await expect(page.getByRole("heading", { name: "Design foundations", exact: true })).toBeVisible();
    await expect(page.getByText("An original English course description.", { exact: true })).toBeVisible();
    const button = page.getByRole("button", { name: language === "en" ? "Add to cart" : "加入购物车", exact: true });
    await expect(button).toBeEnabled(); await button.click();
    await expect(page.getByRole("button", { name: language === "en" ? "Already in cart" : "已加入购物车", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.reload();
    await expect(page.getByRole("combobox", { name: language === "en" ? "Language" : "语言", exact: true })).toHaveValue(language);
    expect(await page.locator("html").getAttribute("lang")).toBe(language);
  });
}

test("confirmed top-up with a failed wallet refresh stays mounted and retries only the wallet", async ({ page }) => {
  await mockVideoApi(page, "member");
  let checks = 0, failRefresh = true;
  await page.route("**/api/v1/wallet/top-ups/payment", route => { checks++; return route.fulfill(json({ status: "paid", points: 500 })); });
  await page.route("**/api/v1/wallet", async route => {
    if (!checks) return route.fallback();
    await new Promise(resolve => setTimeout(resolve, 100));
    return route.fulfill(failRefresh ? { status: 503, ...json(null) } : json({ availablePoints: 1500 }));
  });
  await page.goto("/#/wallet");
  await expect(page.getByRole("button", { name: "Add points", exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.__walletUnmounts = 0;
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if ((node.textContent || "").includes("Loading account data…")) window.__walletUnmounts++;
      }
    }).observe(document.body, { childList: true, subtree: true });
    window.location.hash = "/wallet?paymentTransactionId=payment";
  });
  const retry = page.getByRole("button", { name: "Retry wallet refresh", exact: true });
  await expect(retry).toBeVisible(); await expect(page).toHaveURL(/#\/wallet$/);
  failRefresh = false; await retry.click();
  await expect(page.getByText("Payment confirmed. Your wallet has been refreshed.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "1500 points", exact: true })).toBeVisible();
  expect(checks).toBe(1); expect(await page.evaluate(() => window.__walletUnmounts)).toBe(0);
});

for (const status of ["failed", "cancelled"]) test(`terminal ${status} top-up stops polling`, async ({ page }) => {
  await mockVideoApi(page, "member"); let checks = 0;
  await page.route("**/api/v1/wallet/top-ups/payment", route => { checks++; return route.fulfill(json({ status })); });
  await page.goto("/#/wallet?paymentTransactionId=payment");
  await expect(page.getByText(status === "failed" ? "Payment failed. No points were added." : "Payment was cancelled. No points were added.", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/wallet$/); expect(checks).toBe(1);
});
