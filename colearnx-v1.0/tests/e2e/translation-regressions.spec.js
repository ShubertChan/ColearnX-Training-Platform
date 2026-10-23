import { expect, test } from "@playwright/test";
import { mockVideoApi } from "./video.fixture.js";
import { mockStripe } from "./stripe.fixture.js";

const json = data => ({ contentType: "application/json", body: JSON.stringify({ data }) });
const switchLanguage = (page, language) => page.locator(".language-switcher select").selectOption(language);

for (const width of [390, 1440]) test(`Chinese catalogue, cart and application labels work at ${width}px`, async ({ page }, testInfo) => {
  await mockVideoApi(page, "member");
  await page.route("**/api/v1/courses?**", route => route.fulfill(json([{
    id: "translated-course", title: "Home", description: "Original course description", category: { name: "Design" },
    pricePoints: 100, status: "published", deliveryModes: ["local"], owner: { displayName: "Trainer" },
    refundPolicyPreview: { summary: "Original purchase terms" },
  }])));
  await page.setViewportSize({ width, height: 1000 });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/#/courses?category=Design");
  await switchLanguage(page, "zh-CN");
  const filter = page.getByRole("combobox", { name: "筛选课程类别" });
  await expect(filter).toHaveValue("Design");
  await expect(filter.getByRole("option", { name: "设计" })).toHaveAttribute("value", "Design");
  await page.getByRole("heading", { name: "Home", exact: true }).click();
  await expect(page).toHaveURL(/#\/courses\/translated-course$/);
  await expect(page.getByText("Original course description", { exact: true })).toBeVisible();
  await expect(page.locator(".course-instructor").getByText("Trainer", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "加入购物车", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "课程已加入购物车", exact: true });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByText("“Home”已加入你的购物车。", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await confirmation.getByRole("link", { name: "查看购物车", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page).toHaveURL(/#\/cart$/);
  await page.getByRole("button", { name: "确认最终订单" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/讲师授课.*线下安排/)).toBeVisible();
  await expect(dialog.getByText("Original purchase terms", { exact: true })).toBeVisible();
  await dialog.getByRole("checkbox").check();
  await expect(dialog.getByRole("button", { name: "支付 100 积分" })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`cart-zh-${width}.png`), fullPage: true });
  await dialog.getByRole("button", { name: "返回", exact: true }).click();
  await page.goto("/#/role-application");
  await expect(page.getByRole("heading", { name: "讲师", exact: true })).toBeVisible();
  await expect(page.getByText("未申请", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "申请成为讲师" }).click();
  await page.getByLabel("专业类别 *").fill("Home");
  await switchLanguage(page, "en");
  await expect(page.getByLabel("Subject category *")).toHaveValue("Home");
  await switchLanguage(page, "zh-CN");
  await expect(page.getByLabel("专业类别 *")).toHaveValue("Home");
  expect(errors).toEqual([]);
});

test("verification feedback switches languages without resending or losing entered codes", async ({ page }) => {
  await mockVideoApi(page, "member");
  let sends = 0;
  await page.route("**/api/v1/auth/resend-verification", route => {
    sends++;
    return route.fulfill(json({ resendAvailableAt: new Date(Date.now() + 60_000).toISOString() }));
  });
  await page.goto("/#/verify-email?email=test@example.test");
  await page.getByLabel("Verification code").fill("12345678");
  await page.getByRole("button", { name: "Resend email code" }).click();
  await switchLanguage(page, "zh-CN");
  await expect(page.getByRole("status")).toHaveText("如果此邮箱有待完成的 CoLearnX 注册，新的验证邮件将很快送达。");
  await expect(page.getByLabel("验证码")).toHaveValue("12345678");
  await expect(page.locator(".auth-form button").last()).toBeDisabled();
  await switchLanguage(page, "en");
  await expect(page.getByRole("status")).toContainText("If this address has a pending CoLearnX registration");
  expect(sends).toBe(1);
});

test("payment fields and decline feedback survive a language switch without reloading checkout", async ({ page }) => {
  await mockVideoApi(page, "member");
  await mockStripe(page, false);
  let loads = 0;
  await page.route("**/api/v1/wallet/top-ups/payment/checkout-session", route => {
    loads++;
    return route.fulfill(json({ status: "open", email: "learner@example.test", amountMinor: 500, currency: "sgd", points: 500, publishableKey: "pk_test_fixture", clientSecret: "cs_test_fixture_secret", expiresAt: Math.floor(Date.now() / 1000) + 3600 }));
  });
  await page.goto("/#/wallet/checkout/payment");
  const card = page.getByRole("textbox", { name: "Test card number" });
  await card.fill("4000 0000 0000 0002");
  await page.evaluate(() => { window.__stripeFixture.decline = true; });
  await switchLanguage(page, "zh-CN");
  await expect(page.getByRole("heading", { name: "支付方式" })).toBeVisible();
  await expect(card).toHaveValue("4000 0000 0000 0002");
  await expect(page.locator(".topup-pay-button")).toBeEnabled();
  await page.locator(".topup-pay-button").click();
  await expect(page.getByRole("alert")).toHaveText("您的银行卡付款被拒绝。");
  await switchLanguage(page, "en");
  await expect(page.getByRole("alert")).toHaveText("Your card was declined.");
  await expect(card).toHaveValue("4000 0000 0000 0002");
  expect(loads).toBe(1);
  expect(await page.evaluate(() => window.__stripeFixture.confirms)).toBe(1);
});

test("standard top-up package labels are translated", async ({ page }) => {
  await mockVideoApi(page, "member");
  await page.route("**/api/v1/wallet/top-up-packages", route => route.fulfill(json([{ id: "package", displayName: "500 points", points: 500, amountMinor: 500 }])));
  await page.goto("/#/wallet");
  await switchLanguage(page, "zh-CN");
  await page.getByRole("button", { name: "充值积分", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("500 积分", { exact: true })).toBeVisible();
});

test("empty publishing pages are translated", async ({ page }) => {
  await mockVideoApi(page, "creator");
  await page.route("**/api/v1/my/listings**", route => route.fulfill(json([])));
  await page.goto("/#/published");
  await switchLanguage(page, "zh-CN");
  await expect(page.getByRole("heading", { name: "暂无内容记录" })).toBeVisible();
  await expect(page.getByText("您在创作者工作区创建的内容将显示在这里。")).toBeVisible();
});
