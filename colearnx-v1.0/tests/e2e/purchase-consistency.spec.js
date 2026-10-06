import { expect as baseExpect, test } from "@playwright/test";
import { mockVideoApi } from "./video.fixture.js";

const expect = baseExpect.configure({ timeout: 20000 });
test.describe.configure({ timeout: 60000 });
const json = data => ({ contentType: "application/json", body: JSON.stringify({ data }) });

async function watchPageReplacements(page) {
  await page.evaluate(() => {
    window.__unexpectedPurchaseStates = [];
    const record = node => {
      const text = node.textContent || "";
      for (const value of ["Loading account data…", "Your cart is empty", "Order not found", "Account data unavailable"]) {
        if (text.includes(value)) window.__unexpectedPurchaseStates.push(value);
      }
    };
    new MutationObserver(records => {
      for (const mutation of records) {
        for (const node of mutation.addedNodes) record(node);
        if (mutation.type === "characterData") record(mutation.target);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}

for (const reason of ["不想学", "abcd", "  不想学了  "]) {
  test(`eligible refund accepts a short trimmed reason: ${reason}`, async ({ page }) => {
    const state = await mockVideoApi(page, "member");
    await page.goto("/#/refund/course?orderItem=order-item");
    await expect(page.getByText("Full order-item points refund available.")).toBeVisible();
    await page.getByLabel("Reason for request").fill(reason);
    await page.getByRole("button", { name: "Submit for review", exact: true }).click();
    await expect(page).toHaveURL(/#\/orders$/);
    const requests = state.calls.filter(call => call.path === "/refund-requests");
    expect(requests).toHaveLength(1);
    expect(requests[0].input.reason).toBe(reason.trim());
  });
}

test("refund rejects spaces with a specific message before calling the service", async ({ page }) => {
  const state = await mockVideoApi(page, "member");
  await page.goto("/#/refund/course?orderItem=order-item");
  await page.getByLabel("Reason for request").fill("   ");
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter at least 3 characters for the refund reason.");
  expect(state.calls.filter(call => call.path === "/refund-requests")).toHaveLength(0);
});

for (const walletFails of [false, true]) {
  test(`checkout keeps the confirmation and receipt during background refresh (failure: ${walletFails})`, async ({ page }) => {
    await mockVideoApi(page, "member");
    let purchased = false;
    const order = { id: "order", status: "paid", totalPoints: 100, items: [{ id: "order-item", kind: "course", productId: "course", title: "Recorded design workshop", pricePoints: 100, fulfilmentStatus: "fulfilled", deliveryModes: ["cloud"] }] };
    await page.addInitScript(() => localStorage.setItem("colearnx-cart-v3:test-account", JSON.stringify([{ kind: "course", id: "course" }])));
    await page.route("**/api/v1/orders?**", route => route.fulfill(json(purchased ? [{ id: "order" }] : [])));
    await page.route("**/api/v1/checkout", route => { purchased = true; return route.fulfill(json(order)); });
    await page.route("**/api/v1/wallet", async route => {
      if (!purchased) return route.fallback();
      // Leave the refresh in flight long enough to expose page unmounts.
      await new Promise(resolve => setTimeout(resolve, 100));
      if (walletFails) return route.fulfill({ status: 503, ...json(null) });
      return route.fulfill(json({ availablePoints: 900 }));
    });
    await page.goto("/#/cart");
    await page.getByRole("button", { name: "Review final order" }).click();
    await page.getByRole("checkbox", { name: /I have reviewed/ }).check();
    await watchPageReplacements(page);
    await page.getByRole("button", { name: "Pay 100 points", exact: true }).click();
    await expect(page).toHaveURL(/#\/checkout-success\/order$/);
    await expect(page.getByRole("heading", { name: "Thank you for your purchase" })).toBeVisible();
    if (walletFails) await expect(page.getByText(/Payment succeeded, but some account data could not refresh/)).toBeVisible();
    else await expect(page.getByRole("button", { name: "900 points", exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__unexpectedPurchaseStates)).toEqual([]);
  });
}

test("paid top-up refreshes the wallet once and preserves payment reconciliation", async ({ page }) => {
  await mockVideoApi(page, "member");
  let checkingPayment = false, paymentChecks = 0;
  await page.route("**/api/v1/wallet/top-ups/payment", route => {
    checkingPayment = true; paymentChecks++;
    return route.fulfill(json({ status: "paid", points: 500 }));
  });
  await page.route("**/api/v1/wallet", async route => {
    if (!checkingPayment) return route.fallback();
    await new Promise(resolve => setTimeout(resolve, 100));
    return route.fulfill(json({ availablePoints: 1500 }));
  });
  await page.goto("/#/wallet");
  await expect(page.getByRole("button", { name: "Add points", exact: true })).toBeVisible();
  await watchPageReplacements(page);
  await page.evaluate(() => { window.location.hash = "/wallet?paymentTransactionId=payment"; });
  await expect(page.getByText("Payment confirmed. Your wallet has been refreshed.")).toBeVisible();
  await expect(page).toHaveURL(/#\/wallet$/);
  expect(paymentChecks).toBe(1);
  expect(await page.evaluate(() => window.__unexpectedPurchaseStates)).toEqual([]);
});

for (const [seconds, percent, label] of [[1, 2.94, "1 second"], [1.19, 3.5, "1.19 seconds"]]) {
  test(`34-second video shows ${seconds} seconds as ${percent}%`, async ({ page }) => {
    await mockVideoApi(page, "member");
    await page.route("**/api/v1/order-items/order-item/delivery", route => {
      return route.fulfill(json({ title: "Recorded design workshop", startsAt: "2026-01-01T00:00:00.000Z", onlineVideo: true, playerState: "ready", uniqueContentWatchedSeconds: seconds, durationSeconds: 34, watchedRatio: 0.035, assets: [] }));
    });
    await page.goto("/#/purchases/order-item/watch");
    const sidebar = page.getByLabel("Your learning progress", { exact: true });
    await expect(sidebar.getByLabel(`Server-confirmed unique viewing progress: ${percent}%`, { exact: true })).toBeVisible();
    await expect(sidebar.getByText(`${label} of 34 seconds confirmed`, { exact: true })).toBeVisible();
  });
}
