import assert from "node:assert/strict";
import test from "node:test";
import {
  canPublishReviewedAssets,
  formatReviewFileSize,
  normalizeReviewAssets,
  reviewAssetKey,
} from "./adminReviewAssets.js";

test("normalizes every attachment returned for an admin review", () => {
  const assets = normalizeReviewAssets({
    contentType: "digital",
    assets: [
      { assetId: "asset-1", filename: "guide.pdf", mediaType: "application/pdf", sizeBytes: "2048", status: "ready" },
      { assetId: "asset-2", filename: "slides.pptx", mediaType: "application/vnd.ms-powerpoint", sizeBytes: 4096, status: "ready" },
    ],
  });

  assert.equal(assets.length, 2);
  assert.equal(assets[0].filename, "guide.pdf");
  assert.equal(assets[1].sizeBytes, 4096);
});

test("approval stays unavailable when any attachment is not ready", () => {
  const assets = normalizeReviewAssets({
    assets: [
      { assetId: "asset-1", filename: "guide.pdf", status: "ready" },
      { assetId: "asset-2", filename: "slides.pptx", status: "ready" },
      { assetId: "asset-3", filename: "failed.zip", status: "quarantined" },
    ],
  });

  assert.equal(canPublishReviewedAssets(assets, new Set([reviewAssetKey(assets[0], 0)])), false);
  assert.equal(canPublishReviewedAssets(assets, new Set([
    reviewAssetKey(assets[0], 0),
    reviewAssetKey(assets[1], 1),
  ])), false);
});

test("approval is available only after every attachment is ready and reviewed", () => {
  const assets = normalizeReviewAssets({
    assets: [
      { assetId: "asset-1", filename: "guide.pdf", status: "ready" },
      { assetId: "asset-2", filename: "slides.pptx", status: "ready" },
    ],
  });
  assert.equal(canPublishReviewedAssets(assets, new Set(assets.map(reviewAssetKey))), true);
});

test("legacy single-file submissions remain visible but require R2 migration before review", () => {
  const assets = normalizeReviewAssets({ storageUrlPresent: true, fileStatus: "legacy" });
  assert.equal(assets.length, 1);
  assert.equal(canPublishReviewedAssets(assets, new Set([reviewAssetKey(assets[0], 0)])), false);
  assert.equal(formatReviewFileSize(2 * 1024 * 1024), "2.0 MiB");
});
