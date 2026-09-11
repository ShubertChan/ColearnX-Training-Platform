import { apiClient } from "./client.js";
import { listAllPages } from "./pagination.js";

const unwrap = (response) => response.data.data;
const writeOptions = (key = globalThis.crypto.randomUUID()) => ({ headers: { "Idempotency-Key": key } });
const itemPath = (kind, id) => {
  if (!["course", "content"].includes(kind) || !id) throw new Error("Choose a valid listing.");
  return `/${kind === "course" ? "courses" : "content"}/${encodeURIComponent(id)}`;
};
// Frontend integration contract. Unsupported services must return an error;
// these adapters never substitute demo records or successful local mutations.
export const updateListing = (kind, id, input) => apiClient.patch(itemPath(kind, id), input, writeOptions()).then(unwrap);
export const createListingVersion = (kind, id, input) => apiClient.post(`${itemPath(kind, id)}/versions`, input, writeOptions()).then(unwrap);
export const listListingVersions = (kind, id) => listAllPages(`${itemPath(kind, id)}/versions`);
export const archiveContent = (id, reason) => apiClient.post(`${itemPath("content", id)}/archive`, { reason }, writeOptions()).then(unwrap);
export const cancelCourse = (id, reason) => apiClient.post(`${itemPath("course", id)}/cancel`, { reason }, writeOptions()).then(unwrap);
export const validateCourseResources = (id, contentVersionIds) => apiClient.post(`${itemPath("course", id)}/resources/validate`, { contentVersionIds }).then(unwrap);
export const saveCourseResources = (id, contentVersionIds, validationId) => apiClient.put(`${itemPath("course", id)}/resources`, { contentVersionIds, validationId }, writeOptions()).then(unwrap);
export const getPublishingAnalytics = (kind, filters) => apiClient.get("/my/analytics", { params: { kind, ...filters } }).then(unwrap);
export const submitReport = (input) => apiClient.post("/reports", input, writeOptions()).then(unwrap);
export const listReports = (filters) => listAllPages("/admin/reports", filters);
export const decideReport = (id, input) => apiClient.post(`/admin/reports/${encodeURIComponent(id)}/decision`, input, writeOptions()).then(unwrap);
export const listAuditLogs = (filters) => listAllPages("/admin/audit-logs", filters);
export const getActivityReport = (filters) => apiClient.get("/admin/activity-report", { params: filters }).then(unwrap);
export const adjustPoints = (input, requestKey) => apiClient.post("/admin/wallet-adjustments", input, writeOptions(requestKey)).then(unwrap);
export const serviceMessage = (error) => [404, 405, 501].includes(error?.status)
  ? "This service is not available in the connected environment yet. No change has been saved. You can keep editing and retry after it is connected."
  : error?.message || "The request could not be completed. Please retry.";
