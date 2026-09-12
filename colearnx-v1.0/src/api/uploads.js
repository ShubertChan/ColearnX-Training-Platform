import { apiClient } from "./client.js";
import { getPrivateAssetMediaType } from "../utils/uploadPolicy.js";

const key = () => globalThis.crypto.randomUUID();
const unwrap = (response) => response.data.data;
const options = () => ({ headers: { "Idempotency-Key": key() } });
// Uploads and downloads always use the configured API, including Vite's proxy.
// No simulated files, credentials, or permanent private object URLs are stored.
export const usingLocalUploadDemo = false;

function assetApi(prefix) {
  const base = (id) => `${prefix}/${encodeURIComponent(id)}`;
  return {
    list: async (id) => {
      const data = await apiClient.get(`${base(id)}/assets`).then(unwrap);
      const assets = Array.isArray(data) ? data : data?.assets;
      if (!Array.isArray(assets)) throw new Error("The file service returned an incomplete list.");
      return assets;
    },
    request: (id, file) => apiClient.post(`${base(id)}/upload-intents`, {
      filename: file.name, mediaType: getPrivateAssetMediaType(file), sizeBytes: file.size,
    }, options()).then(unwrap),
    complete: (id, assetId) => apiClient.post(`${base(id)}/upload-intents/${encodeURIComponent(assetId)}/complete`, {}, options()).then(unwrap),
    remove: (id, assetId) => apiClient.delete(`${base(id)}/upload-intents/${encodeURIComponent(assetId)}`, options()),
  };
}
export const contentAssetApi = assetApi("/content-versions");
export const courseAssetApi = assetApi("/courses");
export const listContentAssets = contentAssetApi.list;
export const requestUploadIntent = contentAssetApi.request;
export const completeUploadIntent = contentAssetApi.complete;
export const removeUploadIntent = contentAssetApi.remove;
export const requestContentDownloadUrl = (contentVersionId, assetId) =>
  apiClient.post(`/content-versions/${encodeURIComponent(contentVersionId)}/download-url`,
    typeof assetId === "string" ? { assetId } : {}, options()).then(unwrap);

export function getSafeUploadError(error) {
  const code = error.code || "UPLOAD_FAILED";
  if (code === "NETWORK_ERROR") {
    return {
      code,
      message: "Cannot reach the upload service. Check your connection and try again.",
      requestId: "",
    };
  }
  if (code === "CONTENT_UPLOAD_PENDING_LIMIT") {
    return {
      code,
      message: "An earlier upload is still being cleared. Try again in a moment.",
      requestId: error.requestId || "",
    };
  }
  return {
    code,
    message: error.message || "The upload could not be completed.",
    requestId: error.requestId || "",
  };
}
