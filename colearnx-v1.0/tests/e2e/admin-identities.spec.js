import { expect, test } from "@playwright/test";
import { mockVideoApi } from "./video.fixture.js";

const users = [
  ["trainer", "Alex Trainer", ["member", "trainer"]],
  ["creator", "Casey Creator", ["member", "creator"]],
  ["dual", "Taylor Both", ["member", "trainer", "creator"]],
  ["member", "Morgan Member", ["member"]],
].map(([id, displayName, roles]) => ({ id, displayName, roles, email: `${id}@example.test`, status: "active", profile: { fullName: displayName }, createdAt: "2026-11-01T00:00:00Z" }));

for (const width of [390, 1440]) for (const language of ["en", "zh-CN"]) {
  test(`${language} administrator identities distinguish single and dual roles at ${width}px`, async ({ page }, testInfo) => {
    await mockVideoApi(page, "admin");
    const mutations = [];
    await page.route("**/api/v1/admin/users**", async route => {
      if (route.request().method() !== "GET") mutations.push(route.request().method());
      const url = new URL(route.request().url());
      const found = users.find(user => url.pathname.endsWith(`/${user.id}`));
      const second = url.searchParams.get("page") === "2";
      await route.fulfill({ json: { data: found || { items: second ? [users[3]] : users, total: 54, hasNext: !second } } });
    });
    await page.setViewportSize({ width, height: 1050 });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto("/#/admin");
    await page.locator(".language-switcher select").selectOption(language);
    const zh = language === "zh-CN";
    await page.getByRole("button", { name: zh ? "查看用户身份" : "View user identities", exact: true }).click();
    await expect(page).toHaveURL(/#\/admin\/users$/);
    const overview = page.getByRole("region", { name: zh ? "用户身份" : "User identities", exact: true });
    await expect(overview).toBeVisible();
    const filters = page.locator(".identity-filters");
    const trainer = filters.getByRole("button", { name: zh ? /讲师 2/ : /Trainer 2/ });
    const creator = filters.getByRole("button", { name: zh ? /创作者 2/ : /Creator 2/ });
    const dual = filters.getByRole("button", { name: zh ? /讲师兼创作者 1/ : /Trainer and Creator 1/ });
    await expect(page.locator(".admin-user-row")).toHaveCount(4);
    const alex = page.locator(".admin-user-row").filter({ hasText: "Alex Trainer" });
    await expect(alex.locator(".user-identity.trainer")).toBeVisible();
    await expect(alex.locator(".user-identity.creator")).toHaveCount(0);
    const taylor = page.locator(".admin-user-row").filter({ hasText: "Taylor Both" });
    await expect(taylor.locator(".user-identity.trainer")).toBeVisible();
    await expect(taylor.locator(".user-identity.creator")).toBeVisible();
    await expect(taylor.locator(".user-identity.dual")).toBeVisible();
    expect((await page.getByRole("textbox", { name: zh ? "搜索用户" : "Search users", exact: true }).boundingBox()).height).toBeLessThanOrEqual(60);
    await page.screenshot({ path: testInfo.outputPath(`admin-identities-${language}-${width}.png`), fullPage: true });
    await trainer.click(); await expect(page.locator(".admin-user-row")).toHaveCount(2);
    await creator.click(); await expect(page.locator(".admin-user-row")).toHaveCount(2);
    await dual.click(); await expect(page.locator(".admin-user-row")).toHaveCount(1);
    await page.locator(".language-switcher select").selectOption(zh ? "en" : "zh-CN");
    await expect(filters.locator('[aria-pressed="true"]')).toHaveClass(/dual/);
    const nowZh = !zh;
    await page.getByRole("button", { name: nowZh ? "下一页" : "Next", exact: true }).click();
    await expect(page.locator(".admin-user-row")).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Morgan Member/ })).toBeVisible();
    await filters.locator(".identity-filter.trainer").click();
    await expect(page.getByRole("heading", { name: nowZh ? "本页没有此身份的账户" : "No accounts with this identity on this page", exact: true })).toBeVisible();
    await page.getByRole("button", { name: nowZh ? "上一页" : "Previous", exact: true }).click();
    await expect(page.locator(".admin-user-row")).toHaveCount(4);
    await page.getByRole("button", { name: /Taylor Both/ }).click();
    const current = page.getByRole("region", { name: nowZh ? "当前用户身份" : "Current user identities", exact: true });
    await expect(current.locator(".user-identity.trainer")).toBeVisible();
    await expect(current.locator(".user-identity.creator")).toBeVisible();
    await expect(current.locator(".user-identity.dual")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(mutations).toEqual([]);
    expect(errors).toEqual([]);
  });
}
