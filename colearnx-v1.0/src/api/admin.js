import { apiClient } from "./client";

const unwrap = (response) => response.data.data;

export const getCourseSubmissions = () =>
  apiClient.get("/admin/course-submissions?limit=100").then(unwrap);

export const decideCourseSubmission = (courseRunId, input) =>
  apiClient
    .post(`/admin/course-runs/${courseRunId}/decision`, input)
    .then(unwrap);

export const getContentSubmissions = () =>
  apiClient.get("/admin/content-submissions?limit=100").then(unwrap);

export const decideContentSubmission = (contentVersionId, input) =>
  apiClient
    .post(`/admin/content-versions/${contentVersionId}/decision`, input)
    .then(unwrap);

export const getAdminUsers = ({ status, search, page = 1, limit = 50 } = {}) => {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (status) params.set("status", status);
  if (search?.trim()) params.set("search", search.trim());
  return apiClient.get(`/admin/users?${params.toString()}`).then(unwrap);
};

export const getAdminUser = (userId) =>
  apiClient.get(`/admin/users/${userId}`).then(unwrap);

export const suspendAdminUser = (userId, reason) =>
  apiClient.post(`/admin/users/${userId}/suspend`, { reason }).then(unwrap);

export const reinstateAdminUser = (userId, reason) =>
  apiClient.post(`/admin/users/${userId}/reinstate`, { reason }).then(unwrap);

export const deleteAdminUser = (userId, reason) =>
  apiClient.delete(`/admin/users/${userId}`, { data: { reason } }).then(unwrap);

export const setAdminUserRole = (userId, input) =>
  apiClient.post(`/admin/users/${userId}/roles`, input).then(unwrap);
