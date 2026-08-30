import { apiClient } from "./client";

const unwrap = (response) => response.data.data;
const idempotencyKey = () =>
  globalThis.crypto?.randomUUID?.() ||
  `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const createCheckout = (items) =>
  apiClient
    .post(
      "/checkout",
      { items },
      { headers: { "Idempotency-Key": idempotencyKey() } },
    )
    .then(unwrap);

export const listOrders = () => apiClient.get("/orders?limit=100").then(unwrap);
export const getOrder = (orderId) => apiClient.get(`/orders/${orderId}`).then(unwrap);
