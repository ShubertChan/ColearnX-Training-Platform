import { expect, test } from "@playwright/test";
import { mockVideoApi } from "./video.fixture.js";

for (const width of [1440, 390]) for (const language of ["en", "zh-CN"]) {
  test(`refund states remain readable at ${width}px in ${language}`, async ({ page }, testInfo) => {
    await mockVideoApi(page, "member");
    let refunded = false;
    await page.route("**/api/v1/notifications/refunds*", route => route.fulfill({ json: { data: [] } }));
    await page.route("**/api/v1/orders/order", route => route.fulfill({ json: { data: {
      id: "order", status: refunded ? "refunded" : "paid", totalPoints: 100,
      items: [{ id: "order-item", kind: "course", productId: "course", title: "Recorded design workshop", pricePoints: 100,
        fulfilmentStatus: refunded ? "refunded" : "fulfilled", deliveryModes: ["cloud"],
        refundRecords: [{ id: "refund", status: refunded ? "approved" : "pending", requestedAt: "2026-10-20T10:00:00Z" }] }],
    } } }));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/#/orders");
    await page.getByRole("combobox", { name: "Language", exact: true }).selectOption(language);
    const pending = language === "en" ? "Refund under review" : "退款审核中";
    await expect(page.locator(".refund-status-bar")).toContainText(pending);
    await page.getByRole("link", { name: language === "en" ? "View receipt" : "查看收据", exact: true }).click();
    await expect(page.locator(".refund-status-bar")).toContainText(pending);
    await expect(page.getByRole("link", { name: language === "en" ? "Request refund" : "申请退款", exact: true })).toHaveCount(0);
    await page.goto("/#/refund/course?orderItem=order-item");
    await expect(page.locator(".refund-status-bar")).toContainText(pending);
    await expect(page.locator("form")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`refund-pending-${width}-${language}.png`), fullPage: true });
    refunded = true;
    await page.reload();
    await expect(page.locator(".refund-status-bar")).toContainText(language === "en" ? "The points have been returned to your wallet." : "积分已退回你的钱包。");
    await expect(page.locator("form")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`refund-completed-${width}-${language}.png`), fullPage: true });
  });
}
