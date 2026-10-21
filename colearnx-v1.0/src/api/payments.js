import { apiClient } from "./client";

export async function createTopUpCheckoutSession({
  topUpPackageId,
  idempotencyKey,
  locale = 'en',
}) {
  const response = await apiClient.post(
    "/wallet/top-ups/checkout-session",
    { topUpPackageId, uiMode: 'elements', locale },
    {
      headers: {
        "Idempotency-Key": idempotencyKey,
      },
    },
  );
  return response.data.data;
}

export const getTopUpCheckoutSession = (paymentTransactionId) =>
  apiClient.get(`/wallet/top-ups/${encodeURIComponent(paymentTransactionId)}/checkout-session`).then((response) => response.data.data);

export const getTopUpStatus = (paymentTransactionId) =>
  apiClient.get(`/wallet/top-ups/${paymentTransactionId}`).then((response) => response.data.data);
