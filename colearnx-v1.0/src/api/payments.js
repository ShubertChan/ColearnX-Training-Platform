import { apiClient } from "./client";

export async function createTopUpCheckoutSession({
  topUpPackageId,
  idempotencyKey,
}) {
  const response = await apiClient.post(
    "/wallet/top-ups/checkout-session",
    { topUpPackageId },
    {
      headers: {
        "Idempotency-Key": idempotencyKey,
      },
    },
  );
  return response.data.data;
}

export const getTopUpStatus = (paymentTransactionId) =>
  apiClient.get(`/wallet/top-ups/${paymentTransactionId}`).then((response) => response.data.data);
