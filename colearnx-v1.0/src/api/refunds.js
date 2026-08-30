import { apiClient } from "./client";

const unwrap = (response) => response.data.data;

export const createRefundRequest = (input) =>
  apiClient.post("/refund-requests", input).then(unwrap);

export const getAdminRefundRequests = () =>
  apiClient.get("/admin/refund-requests?limit=100").then(unwrap);

export const decideRefundRequest = (refundRequestId, input) =>
  apiClient
    .post(`/admin/refund-requests/${refundRequestId}/decision`, input)
    .then(unwrap);
