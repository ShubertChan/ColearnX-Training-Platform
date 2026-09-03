import { apiClient } from "./client";
import { getPrivateAssetMediaType } from "../utils/uploadPolicy";

const env = import.meta.env || {};
export const usingLocalUploadDemo = Boolean(env.DEV && !env.VITE_API_BASE_URL);
const demoIntents = new Map();

const id = (prefix) =>
  `${prefix}-${globalThis.crypto?.randomUUID?.() || Date.now().toString(36)}`;

export async function requestUploadIntent(contentVersionId, file) {
  const payload = {
    filename: file.name,
    mediaType: getPrivateAssetMediaType(file),
    sizeBytes: file.size,
  };
  if (usingLocalUploadDemo) {
    const assetId = id("asset");
    const intent = {
      assetId,
      contentVersionId,
      method: "PUT",
      uploadUrl: `demo://private-r2/${assetId}`,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      requiredHeaders: { "Content-Type": payload.mediaType },
      status: "pending",
      ...payload,
    };
    demoIntents.set(assetId, intent);
    return intent;
  }
  const response = await apiClient.post(
    `/content-versions/${contentVersionId}/upload-intents`,
    payload,
    { headers: { "Idempotency-Key": id("upload-intent") } },
  );
  return response.data.data;
}

export async function completeUploadIntent(contentVersionId, assetId) {
  if (usingLocalUploadDemo) {
    const intent = demoIntents.get(assetId);
    if (!intent) {
      const error = new Error("The upload attempt expired. Choose the file and retry.");
      error.code = "UPLOAD_INTENT_NOT_FOUND";
      throw error;
    }
    intent.status = "ready";
    return {
      assetId,
      filename: intent.filename,
      mediaType: intent.mediaType,
      sizeBytes: intent.sizeBytes,
      status: "ready",
      uploadedAt: new Date().toISOString(),
    };
  }
  const response = await apiClient.post(
    `/content-versions/${contentVersionId}/upload-intents/${assetId}/complete`,
    {},
    { headers: { "Idempotency-Key": id("upload-complete") } },
  );
  return response.data.data;
}

export async function listContentAssets(contentVersionId) {
  if (usingLocalUploadDemo) {
    return [...demoIntents.values()]
      .filter((intent) => intent.contentVersionId === contentVersionId && intent.status !== "deleted")
      .map(({ assetId, filename, mediaType, sizeBytes, status }) => ({
        assetId, filename, mediaType, sizeBytes, status,
      }));
  }
  const response = await apiClient.get(`/content-versions/${contentVersionId}/assets`);
  return response.data.data.assets || [];
}

export async function removeUploadIntent(contentVersionId, assetId) {
  if (!assetId) return;
  if (usingLocalUploadDemo) {
    demoIntents.delete(assetId);
    return;
  }
  await apiClient.delete(
    `/content-versions/${contentVersionId}/upload-intents/${assetId}`,
    { headers: { "Idempotency-Key": id("upload-delete") } },
  );
}

export async function requestContentDownloadUrl(contentVersionId, assetIdOrFallback, fallbackInput = {}) {
  const assetId = typeof assetIdOrFallback === "string" ? assetIdOrFallback : undefined;
  const fallback = assetId ? fallbackInput : assetIdOrFallback || {};
  if (usingLocalUploadDemo) {
    const filename = fallback.filename || "colearnx-private-content.txt";
    const blob = new Blob(
      [`CoLearnX private content demo\nVersion: ${contentVersionId}\nGenerated: ${new Date().toISOString()}\n`],
      { type: fallback.mediaType || "text/plain" },
    );
    return {
      downloadUrl: URL.createObjectURL(blob),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      filename,
      mediaType: fallback.mediaType || "text/plain",
      sizeBytes: blob.size,
      demoObjectUrl: true,
    };
  }
  const response = await apiClient.post(
    `/content-versions/${contentVersionId}/download-url`,
    assetId ? { assetId } : {},
    { headers: { "Idempotency-Key": id("content-download") } },
  );
  return response.data.data;
}

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
