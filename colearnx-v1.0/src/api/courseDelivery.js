import { apiClient } from "./client.js";
import { heartbeatBody } from "../utils/videoContract.js";

const unwrap = (response) => response.data.data;
const idempotencyKey = (prefix) =>
  `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`}`;

export const getCourseDelivery = (orderItemId) =>
  apiClient.get(`/order-items/${orderItemId}/delivery`).then(unwrap);

export const requestCourseDownloadUrl = (orderItemId, assetId) =>
  apiClient
    .post(
      `/order-items/${orderItemId}/delivery/download-url`,
      { assetId },
      { headers: { "Idempotency-Key": idempotencyKey("course-download") } },
    )
    .then(unwrap);

export const recordCourseProgress = (orderItemId, input) =>
  apiClient
    .post(`/order-items/${encodeURIComponent(orderItemId)}/progress`, heartbeatBody(input), {
      adapter: "fetch", fetchOptions: { keepalive: true }, timeout: 8000,
    })
    .then(unwrap);
