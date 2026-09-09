import { apiClient } from "./client.js";

const unwrap = (response) => response.data.data;

export const getWallet = () => apiClient.get("/wallet").then(unwrap);

export const getWalletTransactions = () =>
  apiClient.get("/wallet/transactions?limit=50").then(unwrap);

export const getTopUpPackages = ({ signal } = {}) =>
  apiClient.get("/wallet/top-up-packages", { signal }).then(unwrap);
