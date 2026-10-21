import { expect, test } from "@playwright/test";
import { mockVideoApi } from "./video.fixture";

test.beforeEach(({ browserName }) => { if (browserName === "webkit") test.slow(); });

// Shared API-contract fixture: admin decisions survive member page/context closure.
function refundMailbox() {
  const refund = { id: "refund", status: "pending", reason: "Unable to continue", requestedPoints: 100,
    eligibility: { eligible: true }, item: { title: "Design workshop", kind: "course" }, requester: { displayName: "Learner" } };
  let unread = [], acknowledgements = 0;
  const waiting = new Set();
  return {
    get acknowledgements() { return acknowledgements; },
    async admin(page) {
      await mockVideoApi(page, "admin");
      await page.route("**/api/v1/admin/refund-requests**", async route => {
        if (route.request().method() === "POST") {
          const { decision, reason } = route.request().postDataJSON();
          refund.status = decision;
          unread = [{ id: "notice", refundRequestId: refund.id, status: decision, itemTitle: refund.item.title,
            points: refund.requestedPoints, decisionReason: reason, orderId: "order" }];
          for (const wake of waiting) wake();
        }
        await route.fulfill({ json: { data: route.request().method() === "GET" ? [refund] : refund } });
      });
    },
    async member(page) {
      await mockVideoApi(page, "member");
      await page.route("**/api/v1/notifications/refunds**", async route => {
        if (route.request().method() === "POST") { acknowledgements++; unread = []; }
        else if (new URL(route.request().url()).searchParams.has("wait") && !unread.length) {
          await new Promise(resolve => {
            const wake = () => { waiting.delete(wake); page.off("close", wake); resolve(); };
            waiting.add(wake); page.once("close", wake);
          });
        }
        if (!page.isClosed()) await route.fulfill({ json: { data: unread } }).catch(() => {});
      });
    },
  };
}

for (const decision of ["approved", "rejected"]) {
  test(`online member immediately sees ${decision} decision without reloading`, async ({ page, browser }) => {
    const mailbox = refundMailbox();
    await mailbox.admin(page);
    const memberContext = await browser.newContext();
    try {
      const member = await memberContext.newPage();
      await mailbox.member(member);
      await member.goto("/#/home");
      await expect(member.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
      await page.goto("/#/admin/refunds");
      await page.getByLabel("Decision reason", { exact: true }).fill("Request reviewed against the policy");
      await page.getByRole("button", { name: decision === "approved" ? "Approve" : "Reject", exact: true }).click();
      const dialog = member.getByRole("dialog", { name: decision === "approved" ? "Refund approved" : "Refund rejected" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("Request reviewed against the policy")).toBeVisible();
      expect(mailbox.acknowledgements).toBe(0);
      await member.reload();
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Got it" }).click();
      await expect(dialog).toHaveCount(0);
      expect(mailbox.acknowledgements).toBe(1);
      await member.reload();
      await expect(member.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
      await expect(member.getByRole("dialog")).toHaveCount(0);
    } finally { await memberContext.close(); }
  });
}

test("decision made while offline appears at the next authenticated startup on mobile in Chinese", async ({ page, browser }) => {
  const mailbox = refundMailbox();
  await mailbox.admin(page);
  await page.goto("/#/admin/refunds");
  await page.getByLabel("Decision reason", { exact: true }).fill("符合退款条件，已批准。");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  const memberContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const member = await memberContext.newPage();
    await mailbox.member(member);
    await member.addInitScript(() => localStorage.setItem("colearnx.language", "zh-CN"));
    await member.goto("/#/home");
    const dialog = member.getByRole("dialog", { name: "退款申请已批准" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("符合退款条件，已批准。")).toBeVisible();
    expect(await member.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await member.screenshot({ path: "test-results/refund-mobile-zh.png" });
    await dialog.getByRole("button", { name: "我知道了" }).click();
    await expect(dialog).toHaveCount(0);
  } finally { await memberContext.close(); }
});

test("navigating to Users & Roles renders populated users and account details without page errors", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await mockVideoApi(page, "admin");
  const user = { id: "learner", displayName: "Learner Test", email: "learner@example.test", status: "active", roles: ["member"], profile: { fullName: "Learner Test" }, createdAt: "2026-10-01T00:00:00Z" };
  await page.route("**/api/v1/admin/users**", async route => route.fulfill({ json: { data: new URL(route.request().url()).pathname.endsWith("/learner") ? user : [user], meta: { total: 1 } } }));
  await page.goto("/#/admin");
  await page.getByRole("link", { name: "Users & Roles", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Platform users" })).toBeVisible();
  await page.getByRole("button", { name: /Learner Test/ }).click();
  await expect(page.getByRole("heading", { name: "Learner Test" })).toBeVisible();
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("zh-CN");
  await expect(page.getByRole("button", { name: "冻结账户" })).toBeVisible();
  expect(errors).toEqual([]);
});
