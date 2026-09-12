import { apiClient } from "./client";
import { listAllPages } from "./pagination.js";

const unwrap = (response) => response.data.data;

export const createRefundRequest = (input) =>
  apiClient.post("/refund-requests", input).then(unwrap);

export const getAdminRefundRequests = () =>
  listAllPages("/admin/refund-requests");

export const decideRefundRequest = (refundRequestId, input) =>
  apiClient
    .post(`/admin/refund-requests/${refundRequestId}/decision`, input)
    .then(unwrap);
