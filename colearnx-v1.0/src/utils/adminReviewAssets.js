function normalizeSizeBytes(value) {
  if (value === null || value === undefined || value === "") return null;
  const size = Number(value);
  return Number.isFinite(size) ? size : null;
}

export function normalizeReviewAssets(item = {}) {
  const source = Array.isArray(item.assets) ? item.assets : [];
  if (source.length) {
    return source.map((asset, index) => ({
      assetId: asset?.assetId || null,
      filename: String(asset?.filename || `File ${index + 1}`),
      mediaType: String(asset?.mediaType || item.contentType || "File"),
      sizeBytes: normalizeSizeBytes(asset?.sizeBytes),
      status: String(asset?.status || "missing").toLowerCase(),
    }));
  }

  const status = String(item.fileStatus || "missing").toLowerCase();
  if (!item.storageUrlPresent && status === "missing") return [];
  return [{
    assetId: item.asset?.assetId || null,
    filename: String(item.asset?.filename || "Uploaded file"),
    mediaType: String(item.asset?.mediaType || item.contentType || "File"),
    sizeBytes: normalizeSizeBytes(item.asset?.sizeBytes),
    status,
  }];
}

export function reviewAssetKey(asset, index = 0) {
  return asset.assetId || `legacy-${index}`;
}

export function canPublishReviewedAssets(assets, previewedAssetKeys) {
  return assets.length > 0 && assets.every((asset, index) => (
    asset.status === "ready" && previewedAssetKeys.has(reviewAssetKey(asset, index))
  ));
}

export function formatReviewFileSize(sizeBytes) {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return "Size unavailable";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 ** 2) return `${(sizeBytes / 1024).toFixed(1)} KiB`;
  return `${(sizeBytes / 1024 ** 2).toFixed(1)} MiB`;
}
