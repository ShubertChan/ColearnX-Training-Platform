import { apiClient } from "./client.js";

const unwrap = (response) => response.data.data;
export const getWallet = () => apiClient.get("/wallet").then(unwrap);
export const getWalletTransactions = async () => {
  const transactions = []; let cursor;
  do {
    const response = await apiClient.get("/wallet/transactions", { params: { limit: 100, ...(cursor ? { cursor } : {}) } });
    const data = response.data.data;
    transactions.push(...(Array.isArray(data) ? data : data?.items || []));
    cursor = response.data.meta?.nextCursor || data?.nextCursor || null;
  } while (cursor);
  return transactions;
};
export const getTopUpPackages = ({ signal } = {}) => apiClient.get("/wallet/top-up-packages", { signal }).then(unwrap);
