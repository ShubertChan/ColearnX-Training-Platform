export const MAX_PRIVATE_ASSET_BYTES = 100 * 1024 * 1024;

export const PRIVATE_ASSET_TYPES = Object.freeze({
  "application/pdf": [".pdf"],
  "application/zip": [".zip"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "video/mp4": [".mp4"],
});

const typeAliases = Object.freeze({
  "application/x-zip-compressed": "application/zip",
});

const extensionType = Object.entries(PRIVATE_ASSET_TYPES).reduce(
  (result, [mediaType, extensions]) => {
    extensions.forEach((extension) => {
      result[extension] = mediaType;
    });
    return result;
  },
  {},
);

export const PRIVATE_ASSET_ACCEPT = Object.values(PRIVATE_ASSET_TYPES)
  .flat()
  .join(",");

export function getPrivateAssetMediaType(file) {
  if (!file) return "";
  const browserType = typeAliases[file.type] || file.type;
  if (PRIVATE_ASSET_TYPES[browserType]) return browserType;
  const dot = file.name?.lastIndexOf(".") ?? -1;
  const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
  return extensionType[extension] || "";
}

export function validatePrivateAsset(file) {
  if (!file) {
    return { valid: false, code: "FILE_REQUIRED", message: "Choose a file to upload." };
  }
  if (file.size <= 0) {
    return { valid: false, code: "FILE_EMPTY", message: "The selected file is empty." };
  }
  if (file.size > MAX_PRIVATE_ASSET_BYTES) {
    return {
      valid: false,
      code: "CONTENT_FILE_TOO_LARGE",
      message: "The maximum private file size is 100 MiB.",
    };
  }
  const mediaType = getPrivateAssetMediaType(file);
  if (!mediaType) {
    return {
      valid: false,
      code: "CONTENT_FILE_TYPE_NOT_ALLOWED",
      message: "Use PDF, ZIP, JPEG, PNG, WebP or MP4.",
    };
  }
  return { valid: true, mediaType };
}

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let amount = bytes / 1024;
  let unit = units[0];
  for (let index = 1; amount >= 1024 && index < units.length; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${unit}`;
}
