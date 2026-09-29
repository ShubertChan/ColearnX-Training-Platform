import { expect, test } from "@playwright/test";
import { mockVideoApi } from "./video.fixture";

test("trainer can choose one offline instructor-led course and save its purchaser announcement", async ({ page }) => {
  await mockVideoApi(page, "trainer");
  const creations = [];
  await page.route("**/api/v1/courses", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    creations.push(route.request().postDataJSON());
    await route.fulfill({ json: { data: { id: "new-course" } } });
  });
  await page.goto("/#/trainer/course-editor");
  await expect(page.getByRole("radio", { name: /Video course/ })).toBeChecked();
  await page.getByRole("radio", { name: /Instructor-led course/ }).check();
  await expect(page.getByRole("radio", { name: /Online — live session/ })).toBeChecked();
  await page.getByRole("radio", { name: /Offline — arrange directly/ }).check();
  await expect(page.getByRole("radio", { name: /Online — live session/ })).not.toBeChecked();
  await expect(page.getByRole("radio", { name: /Offline — arrange directly/ })).toBeChecked();
  await expect(page.getByLabel("Live-session link (optional)")).toHaveCount(0);
  await page.getByLabel("Course title").fill("Studio painting");
  await page.getByLabel("Public description").fill("A guided studio session.");
  await page.getByLabel("Price in points").fill("30");
  await page.getByLabel("Course announcement for purchasers").fill("Contact me to agree a venue and time.");
  await page.getByLabel("Trainer contact for purchasers").fill("trainer@example.test");
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect.poll(() => creations).toHaveLength(1);
  expect(creations[0]).toMatchObject({
    deliveryModes: ["local"], progressTrackingType: "none", fulfilmentInstructions: "Contact me to agree a venue and time.", trainerContact: "trainer@example.test", joinUrl: null,
  });
});
