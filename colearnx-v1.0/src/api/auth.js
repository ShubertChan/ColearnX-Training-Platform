import { apiClient } from "./client";

const unwrap = (response) => response.data.data;

export const registerAccount = (input) =>
  apiClient.post("/auth/register", input).then(unwrap);

export const loginAccount = (input) =>
  apiClient.post("/auth/login", input).then(unwrap);

export const logoutAccount = () => apiClient.post("/auth/logout").then(unwrap);

export const getCurrentUser = () => apiClient.get("/me").then(unwrap);

export const updateCurrentUser = (input) =>
  apiClient.patch("/me", input).then(unwrap);
