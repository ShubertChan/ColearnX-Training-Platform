import { expect as baseExpect, test } from "@playwright/test";
import { mockVideoApi } from "./video.fixture.js";
import { mockStripe } from "./stripe.fixture.js";
const expect = baseExpect.configure({ timeout: 15000 });
test.setTimeout(60000);
const json = data => ({ contentType: "application/json", body: JSON.stringify({ data }) });
const session = { status: "open", email: "learner@example.test", amountMinor: 500, currency: "sgd", points: 500, publishableKey: "pk_test_fixture", clientSecret: "cs_test_fixture_secret", expiresAt: Math.floor(Date.now() / 1000) + 3600 };

async function setup(page, wallets = true) {
  const state = await mockVideoApi(page, "member");
  await mockStripe(page, wallets);
  // The app polls in the background; include its query-string requests so
  // slower browser runs cannot fall through to a nonexistent local API.
  await page.route("**/api/v1/notifications/refunds*", route => route.fulfill(json([])));
  let creates = 0;
  await page.route("**/api/v1/wallet/top-up-packages", route => route.fulfill(json([{ id: "package", displayName: "500 points", points: 500, amountMinor: 500 }])));
  await page.route("**/api/v1/wallet/top-ups/checkout-session", route => {
    const body = route.request().postDataJSON();
    expect(body.uiMode).toBe("elements"); expect(body.topUpPackageId).toBe("package");
    creates++; return route.fulfill(json({ paymentTransactionId: "payment", topUpOrderId: "topup", status: "pending" }));
  });
  await page.route("**/api/v1/wallet/top-ups/payment/checkout-session", route => route.fulfill(json(session)));
  await page.route("**/api/v1/wallet/top-ups/payment", route => route.fulfill(json({ status: "paid", points: 500 })));
  return { state, creates: () => creates };
}

for (const width of [1440, 768, 390]) for (const language of ["en", "zh-CN"]) {
  test(`onsite checkout places wallets below the payment heading and above other methods at ${width}px in ${language}`, async ({ page }, testInfo) => {
    const fixture = await setup(page);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/#/wallet");
    await page.getByRole("combobox", { name: "Language", exact: true }).selectOption(language);
    await page.getByRole("button", { name: language === "en" ? "Add points" : "充值积分", exact: true }).click();
    await page.getByRole("button", { name: language === "en" ? "Continue" : "继续", exact: true }).click();
    await page.getByRole("button", { name: language === "en" ? "Continue to secure checkout" : "前往安全支付", exact: true }).click();
    await expect(page).toHaveURL(/#\/wallet\/checkout\/payment$/);
    const payment = page.getByTestId("stripe-payment-fixture");
    const express = page.getByTestId("stripe-express-fixture");
    await expect(page.getByRole("button", { name: "Apple Pay", exact: true })).toBeVisible();
    await expect(page.locator(".topup-pay-button")).toBeEnabled();
    await expect(page.locator(".topup-payment-divider")).toBeVisible();
    const paymentBox = await payment.boundingBox(), expressBox = await express.boundingBox();
    const headingBox = await page.getByRole("heading", { name: language === "en" ? "Payment method" : "支付方式", exact: true }).boundingBox();
    expect(expressBox.y).toBeGreaterThan(headingBox.y + headingBox.height);
    expect(paymentBox.y).toBeGreaterThan(expressBox.y + expressBox.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`checkout-${width}-${language}.png`), fullPage: true });
    await page.reload();
    await expect(page.getByRole("button", { name: "Apple Pay", exact: true })).toBeVisible();
    expect(fixture.creates()).toBe(1);
    await page.getByRole("button", { name: "Apple Pay", exact: true }).click();
    await expect(page).toHaveURL(/#\/wallet$/);
    await expect(page.getByText(language === "en" ? "Payment confirmed. Your wallet has been refreshed." : "付款已确认，钱包已刷新。", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__stripeFixture.confirms)).toBe(1);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.__paymentCspViolations)).toEqual([]);
  });
}

test("unsupported wallets disappear and card decline can be retried", async ({ page }) => {
  await setup(page, false);
  await page.goto("/#/wallet/checkout/payment");
  const pay = page.getByRole("button", { name: /^Pay / });
  await expect(pay).toBeEnabled();
  await expect(page.getByRole("region", { name: "Express payment" })).toBeHidden();
  await page.evaluate(() => { window.__stripeFixture.decline = true; });
  await pay.click();
  await expect(page.getByRole("alert")).toHaveText("Your card was declined.");
  await page.evaluate(() => { window.__stripeFixture.decline = false; });
  await pay.click();
  await expect(page).toHaveURL(/#\/wallet$/);
});
