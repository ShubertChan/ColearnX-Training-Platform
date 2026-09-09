import { apiClient } from "./client.js";

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

export const listOrders = async () => {
  const orders = [];
  let cursor;
  do {
    const response = await apiClient.get("/orders", {
      params: { limit: 100, ...(cursor ? { cursor } : {}) },
    });
    orders.push(...response.data.data);
    cursor = response.data.meta?.nextCursor || null;
  } while (cursor);
  return orders;
};
export const getOrder = (orderId) => apiClient.get(`/orders/${orderId}`).then(unwrap);
