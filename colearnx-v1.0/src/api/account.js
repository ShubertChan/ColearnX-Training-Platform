import { apiClient } from "./client.js";

const unwrap = (response) => response.data.data;

export const getPublicProfile = (userId) =>
  apiClient.get(`/profiles/${userId}`).then(unwrap);

export const requestDataExport = () =>
  apiClient.post("/me/data-export").then(unwrap);

export const requestAccountDeletion = (input) =>
  apiClient.post("/me/deletion-requests", input).then(unwrap);
