import { apiClient } from "./client.js";
import { getPrivateAssetMediaType } from "../utils/uploadPolicy.js";
import { isVideoAsset } from "../utils/videoContract.js";

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
      return prefix === "/courses" ? assets.filter(asset => !isVideoAsset(asset)) : assets;
    },
    request: (id, file, { requestKey = key() } = {}) => apiClient.post(`${base(id)}/upload-intents`, {
      filename: file.name, mediaType: getPrivateAssetMediaType(file), sizeBytes: file.size,
    }, { headers: { "Idempotency-Key": requestKey } }).then(unwrap),
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
  // W8: the server inspects every file's real content before it is accepted.
  // These messages are fixed here (and translated), not echoed from the
  // server, and deliberately do not say which check fired.
  const securityMessages = {
    UPLOAD_CONTENT_REJECTED: "This file was blocked by the security check. Upload the original document in a supported format.",
    UPLOAD_SCAN_UNAVAILABLE: "The file could not be security-checked right now. Wait a moment, then retry the upload.",
    UPLOAD_OBJECT_CHANGED: "The file changed while it was being checked. Retry the upload.",
  };
  if (Object.hasOwn(securityMessages, code)) {
    return { code, message: securityMessages[code], requestId: error.requestId || "" };
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
