import { apiClient } from "./client";

export async function getRefundNotifications({ wait = false, signal } = {}) {
  const response = await apiClient.get("/notifications/refunds", {
    params: wait ? { wait: "1" } : undefined, signal, timeout: 30000,
  });
  return response.data.data;
}

export async function acknowledgeRefundNotification(id, signal) {
  await apiClient.post(`/notifications/refunds/${encodeURIComponent(id)}/read`, {}, { signal });
}
