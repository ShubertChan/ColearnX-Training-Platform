import { expect, test } from "@playwright/test";
import { mockVideoApi } from "./video.fixture";

const roleRequest = (id, name) => ({ id, applicant: { id: `user-${id}`, displayName: name }, requestedRole: "creator", status: "pending", submittedAt: "2026-09-19T00:00:00Z", supportingText: "Category: Art\nExperience: Ten years\nReason: Share my work" });
async function mailbox(page, queues) {
  const calls = [];
  await page.route("**/api/v1/admin/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname.replace("/api/v1/admin/", "");
    let data;
    if (path === "role-applications") data = queues.roles;
    else if (path === "trainer-certifications") data = queues.certifications;
    else if (path === "refund-requests") data = queues.refunds;
    else if (path.startsWith("users/user-")) data = { id: path.slice(6), displayName: "Alice", email: "alice@example.test", roles: ["member"], status: "active", profile: { fullName: "Alice Applicant" } };
    else if (path.endsWith("/decision")) {
      calls.push({ path, input: request.postDataJSON(), key: request.headers()["idempotency-key"] });
      const id = path.split("/")[1], items = path.startsWith("trainer-certifications") ? queues.certifications : queues.roles;
      const item = items.find((value) => value.id === id);
      if (item) item.status = request.postDataJSON().decision;
      data = item;
    } else return route.fallback();
    await route.fulfill({ json: { data, meta: { total: data?.length } } });
  });
  return calls;
}

test("admin mailbox reads three request types, persists read state and opens the exact role application", async ({ page }) => {
  await mockVideoApi(page, "admin");
  const queues = { roles: [roleRequest("other", "Other applicant"), roleRequest("alice", "Alice")], certifications: [{ id: "cert", trainer: { displayName: "Trainer Bob" }, certificationName: "Teaching Certificate", status: "pending" }], refunds: [{ id: "refund", requester: { displayName: "Chris" }, item: { title: "Course refund" }, status: "pending", requestedPoints: 100 }] };
  const calls = await mailbox(page, queues);
  await page.goto("/#/admin/inbox");
  await expect(page.getByRole("button", { name: "Admin inbox, 4 unread", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /creator application Alice/ }).click();
  await expect(page.getByRole("button", { name: "Admin inbox, 3 unread", exact: true })).toBeVisible();
  expect(calls).toHaveLength(0);
  await page.getByRole("link", { name: "Open request" }).click();
  await expect(page).toHaveURL(/application=alice/);
  await expect(page.getByRole("heading", { name: "Alice", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Admin inbox, 3 unread", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Admin inbox, 3 unread", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mark all as read" }).click();
  await expect(page.getByRole("button", { name: "Admin inbox, 0 unread", exact: true })).toBeVisible();
  expect(calls).toHaveLength(0);
  await page.getByRole("button", { name: /Refund request Chris/ }).click();
  await page.getByRole("link", { name: "Open request" }).click();
  await expect(page).toHaveURL(/request=refund/);
  await expect(page.getByText("Course refund", { exact: true })).toBeVisible();
});

test("member submission produces new mail on the admin's next refresh", async ({ page, browser }) => {
  const queues = { roles: [], certifications: [], refunds: [] };
  await mockVideoApi(page, "admin"); await mailbox(page, queues);
  await page.goto("/#/admin/inbox");
  await expect(page.getByRole("heading", { name: "No messages", exact: true })).toBeVisible();
  const memberContext = await browser.newContext();
  try {
    const member = await memberContext.newPage(); await mockVideoApi(member, "member");
    await member.route("**/api/v1/role-applications**", async (route) => {
      if (route.request().method() === "POST") {
        const input = route.request().postDataJSON();
        queues.roles.push({ ...roleRequest("new", "New member"), ...input });
      }
      await route.fulfill({ json: { data: route.request().method() === "POST" ? queues.roles[0] : queues.roles } });
    });
    await member.goto(new URL("/#/role-application", page.url()).href);
    await member.getByRole("button", { name: "Apply for Creator", exact: true }).click();
    await member.getByLabel("Subject category *", { exact: true }).fill("Art");
    await member.getByLabel("Relevant experience *", { exact: true }).fill("Ten years");
    await member.getByLabel("Why are you applying? *", { exact: true }).fill("Share my work");
    await member.getByRole("button", { name: "Submit application", exact: true }).click();
    await expect.poll(() => queues.roles.length).toBe(1);
    await expect(member.getByRole("button", { name: /Admin inbox/ })).toHaveCount(0);
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("button", { name: "Admin inbox, 1 unread", exact: true })).toBeVisible();
    await expect(page.getByText("1 new application message", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /creator application New member/ })).toBeVisible();
  } finally { await memberContext.close(); }
});

test("certification mail opens an actionable review and approval updates the inbox", async ({ page }) => {
  await mockVideoApi(page, "admin");
  const queues = { roles: [], refunds: [], certifications: [{ id: "cert", trainer: { displayName: "Bob" }, certificationName: "Teaching Certificate", evidenceUrl: "https://example.test/cert", status: "pending" }] };
  const calls = await mailbox(page, queues);
  await page.goto("/#/admin/inbox");
  await page.getByRole("button", { name: /Trainer certification Bob/ }).click();
  await page.getByRole("link", { name: "Open request" }).click();
  await expect(page.getByRole("link", { name: "Open certification evidence" })).toHaveAttribute("href", "https://example.test/cert");
  await page.getByLabel("Decision reason for certification cert").fill("Qualification verified");
  await page.getByRole("button", { name: "Approve certification", exact: true }).click();
  await expect(page.getByText("Qualification verified", { exact: true })).toBeVisible();
  expect(calls).toHaveLength(1); expect(calls[0].key).toBeTruthy();
  await page.getByRole("button", { name: "Admin inbox, 0 unread", exact: true }).click();
  await expect(page.getByRole("button", { name: /Trainer certification Bob.*approved/ })).toBeVisible();
});

test("mailbox fits a narrow screen and reports queue failures without erasing existing messages", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockVideoApi(page, "admin");
  await mailbox(page, { roles: [roleRequest("alice", "Alice")], refunds: [], certifications: [] });
  await page.goto("/#/admin/inbox");
  await expect(page.getByRole("button", { name: "Admin inbox, 1 unread", exact: true })).toBeVisible();
  await page.route("**/api/v1/admin/role-applications**", (route) => route.fulfill({ status: 503, json: { error: { message: "Offline" } } }));
  await page.getByRole("button", { name: "Refresh inbox", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Previously loaded messages are retained");
  await expect(page.getByRole("button", { name: /creator application Alice/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "work/inbox-mobile.png", fullPage: true });
});
