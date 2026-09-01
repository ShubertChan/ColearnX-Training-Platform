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
      method: "PUT",
      uploadUrl: `demo://private-r2/${assetId}`,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      requiredHeaders: { "Content-Type": payload.mediaType },
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

export async function requestContentDownloadUrl(contentVersionId, fallback = {}) {
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
    {},
    { headers: { "Idempotency-Key": id("content-download") } },
  );
  return response.data.data;
}

export function getSafeUploadError(error) {
  return {
    code: error.code || "UPLOAD_FAILED",
    message: error.message || "The upload could not be completed.",
    requestId: error.requestId || "",
  };
}
