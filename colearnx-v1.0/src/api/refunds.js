import { apiClient, mutateApi } from "./client";
import { listAllPages } from "./pagination.js";

const unwrap = (response) => response.data.data;

export const createRefundRequest = (input, requestKey = crypto.randomUUID()) =>
  apiClient.post("/refund-requests", input, { headers: { "Idempotency-Key": requestKey } }).then(unwrap);

export const getAdminRefundRequests = () =>
  listAllPages("/admin/refund-requests");

export const decideRefundRequest = (refundRequestId, input) =>
  mutateApi("post", `/admin/refund-requests/${refundRequestId}/decision`, input)
    .then(unwrap);
