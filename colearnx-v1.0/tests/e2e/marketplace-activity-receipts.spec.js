import { expect, test } from "@playwright/test";
import { mockVideoApi } from "./video.fixture.js";

for (const [path, endpoint] of [["courses", "courses"], ["contents", "content"]]) {
  test(`${path} show the same sales and download counts on the card and detail`, async ({ page }) => {
    await mockVideoApi(page, "member");
    await page.route(`**/api/v1/${endpoint}?**`, route => route.fulfill({ json: { data: [
      { id: "listing", title: "Workshop guide", status: "published", pricePoints: 10, activity: { sales: 2, claimedOrders: 1, fileDownloads: 3, fileDownloadsSince: "2026-11-18T09:00:00Z" } },
      { id: "new", title: "New listing", status: "published", pricePoints: 0, activity: { sales: 0, claimedOrders: 0, fileDownloads: 0 } },
      { id: "older", title: "Older response", status: "published", pricePoints: 10, activity: { sales: 2, downloads: 1 } },
    ] } }));
    await page.goto(`/#/${path}`);
    const card = title => page.locator(".marketplace-listing-card").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
    await expect(card("New listing").locator("dd")).toHaveText(["0", "0", "0"]);
    await expect(card("Older response").locator("dd")).toHaveText(["2", "1", "—"]);
    await expect(card("Workshop guide").locator("dd")).toHaveText(["2", "1", "3"]);
    await expect(card("Workshop guide").getByText(/File downloads tracked since.*2026/)).toBeVisible();
    await card("Workshop guide").getByRole("link", { name: "Workshop guide" }).click();
    await expect(page.locator(".listing-activity dd")).toHaveText(["2", "1", "3"]);
    await page.getByRole("combobox", { name: "Language" }).selectOption("zh-CN");
    await expect(page.locator(".listing-activity dd")).toHaveText(["2 笔", "1 笔", "3 次"]);
  });
}

test("mixed receipts retain each posting and narrow My Learning rows separate title and type", async ({ page }) => {
  await mockVideoApi(page, "member");
  const items = [
    { id: "course-line", kind: "course", title: "Design workshop", productId: "course", pricePoints: 20, transactionReference: "paid-course", deliveryModes: ["cloud"] },
    { id: "file-line", kind: "content", title: "Workbook", productId: "file", pricePoints: 10, transactionReference: "paid-workbook" },
  ].map(item => ({ ...item, fulfilmentStatus: "fulfilled" }));
  await page.route("**/api/v1/orders?**", route => route.fulfill({ json: { data: [{ id: "order" }] } }));
  await page.route("**/api/v1/orders/order", route => route.fulfill({ json: { data: { id: "order", status: "paid", totalPoints: 30, items } } }));
  await page.goto("/#/checkout-success/order");
  for (const item of items) {
    const line = page.locator(".receipt-postings li").filter({ hasText: item.title });
    await expect(line.locator("code")).toHaveText(item.transactionReference);
  }
  await page.goto("/#/purchases");
  for (const width of [390, 700]) {
    await page.setViewportSize({ width, height: 850 });
    const summaries = page.locator(".learning-item-summary");
    await expect(summaries).toHaveCount(2);
    for (const summary of await summaries.all()) {
      const title = await summary.locator(":scope > b").boundingBox();
      const type = await summary.locator(":scope > small").boundingBox();
      expect(type.y).toBeGreaterThanOrEqual(title.y + title.height + 2);
    }
  }
});

test("a direct link can open a free receipt outside the loaded order history", async ({ page }) => {
  await mockVideoApi(page, "member");
  await page.route("**/api/v1/orders?**", route => route.fulfill({ status: 503, json: { error: { message: "History unavailable" } } }));
  await page.route("**/api/v1/orders/free", route => route.fulfill({ json: {
    data: { id: "free", orderNo: "ORD-FREE", status: "paid", totalPoints: 0, items: [] },
  } }));
  await page.goto("/#/checkout-success/free");
  await expect(page.getByText("ORD-FREE", { exact: true })).toBeVisible();
  await expect(page.getByText("No points charged", { exact: true })).toBeVisible();
});
