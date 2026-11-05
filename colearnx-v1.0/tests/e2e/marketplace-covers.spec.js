import { expect, test } from "@playwright/test";
import { mockVideoApi } from "./video.fixture.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1sAAAAASUVORK5CYII=", "base64");
const preview = `data:image/png;base64,${png.toString("base64")}`;

for (const kind of ["course", "content"]) {
  test(`${kind} market shows covers, fallbacks and inset controls on desktop and mobile`, async ({ page }, testInfo) => {
    await mockVideoApi(page, "member");
    const resource = kind === "content";
    await page.route(`**/api/v1/${resource ? "content" : "courses"}?**`, route => route.fulfill({ json: { data: [
      { id: "covered", title: "Design foundations", description: "Create practical projects with guided examples.", pricePoints: 100, hasCover: true,
        status: "published", contentType: "digital", deliveryModes: ["cloud"], owner: { displayName: "Alex Chen" } },
      { id: "default", title: "Short workshop", description: "A short introduction.", pricePoints: 50,
        status: "published", contentType: "digital", deliveryModes: ["cloud"], owner: { displayName: "Alex Chen" } },
      { id: "missing-cover", title: "Study notes", description: "A listing with an unavailable image.", pricePoints: 25, hasCover: true,
        status: "published", contentType: "digital", deliveryModes: ["cloud"], owner: { displayName: "Alex Chen" } },
    ] } }));
    await page.route(`**/api/v1/listing-covers/${kind}/covered`, route => route.fulfill({ contentType: "image/png", body: png }));
    await page.route(`**/api/v1/listing-covers/${kind}/missing-cover`, route => route.fulfill({ status: 404 }));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/#/${resource ? "contents" : "courses"}`);
    const card = page.locator(".marketplace-listing-card").filter({ hasText: "Design foundations" });
    const cover = card.locator(".marketplace-listing-cover");
    await expect.poll(() => cover.locator("img").evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
    await expect(page.locator(".marketplace-listing-card").filter({ hasText: "Short workshop" }).locator(".marketplace-listing-cover svg")).toBeVisible();
    await expect(page.locator(".marketplace-listing-card").filter({ hasText: "Study notes" }).locator(".marketplace-listing-cover svg")).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const cardBox = await card.boundingBox(), coverBox = await cover.boundingBox();
      const titleBox = await card.getByRole("heading").boundingBox();
      const viewBox = await card.getByRole("link", { name: "View", exact: true }).boundingBox();
      expect(coverBox.x - cardBox.x).toBeGreaterThanOrEqual(12);
      expect(titleBox.x - (coverBox.x + coverBox.width)).toBeGreaterThanOrEqual(10);
      expect(cardBox.x + cardBox.width - (viewBox.x + viewBox.width)).toBeGreaterThanOrEqual(12);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${kind}-market-${width}.png`), fullPage: true });
    }
  });

  test(`${kind} owner can upload, reload and remove a draft cover`, async ({ page }) => {
    const course = kind === "course";
    await mockVideoApi(page, course ? "trainer" : "creator");
    let image = null, uploads = 0;
    await page.route("**/api/v1/my/listings", route => route.fulfill({ json: { data: [{
      id: "draft", contentVersionId: "version", kind, title: "Cover example", description: "Example draft",
      pricePoints: 20, status: "draft", versionStatus: "draft", fileStatus: "ready", storageUrlPresent: true,
      asset: { assetId: "fixture", status: "ready" }, hasCover: Boolean(image), deliveryModes: ["live"], startsAt: "2030-01-01T00:00:00Z",
    }] } }));
    await page.route(`**/api/v1/listing-covers/${kind}/${course ? "draft" : "version"}**`, route => {
      const method = route.request().method();
      if (method === "PUT") {
        expect(route.request().headers()["content-type"]).toBe("image/png");
        expect(route.request().postDataBuffer()).toEqual(png);
        image = preview; uploads++;
      }
      if (method === "DELETE") image = null;
      return route.fulfill({ json: { data: { image } } });
    });
    await page.goto(`/#/${course ? "trainer/course-editor" : "creator/content-editor"}?draft=draft`);
    await page.getByLabel("Cover image (optional)", { exact: true }).setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: png });
    await expect(page.getByText("Cover image saved.", { exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "Listing cover preview" })).toHaveAttribute("src", preview);
    expect(uploads).toBe(1);
    await page.reload();
    await expect(page.getByRole("img", { name: "Listing cover preview" })).toHaveAttribute("src", preview);
    await page.getByRole("button", { name: "Remove cover", exact: true }).click();
    await expect(page.getByText("Cover image removed.", { exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "Listing cover preview" })).toHaveCount(0);
  });
}
