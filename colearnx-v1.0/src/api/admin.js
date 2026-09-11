import { apiClient } from "./client.js";

const unwrap = (response) => response.data.data;

async function listEveryPage(path) {
  const items = []; const seen = new Set(); let cursor;
  for (let page = 1; page <= 10_000; page += 1) {
    const response = await apiClient.get(path, { params: { limit: 100, page, ...(cursor ? { cursor } : {}) } });
    const data = response.data.data; const batch = Array.isArray(data) ? data : data?.items || []; let added = 0;
    batch.forEach((item) => { if (seen.has(item.id)) return; seen.add(item.id); items.push(item); added += 1; });
    cursor = response.data.meta?.nextCursor || data?.nextCursor || null;
    if (!cursor && (batch.length < 100 || added === 0)) break;
  }
  return items;
}

export const getCourseSubmissions = () => listEveryPage("/admin/course-submissions");
export const decideCourseSubmission = (courseRunId, input) => apiClient.post(`/admin/course-runs/${courseRunId}/decision`, input).then(unwrap);
export const getContentSubmissions = () => listEveryPage("/admin/content-submissions");
export const decideContentSubmission = (contentVersionId, input) => apiClient.post(`/admin/content-versions/${contentVersionId}/decision`, input).then(unwrap);
export const previewContentSubmission = (contentVersionId, assetId) => apiClient.post(`/admin/content-versions/${contentVersionId}/preview-url`, assetId ? { assetId } : {}).then(unwrap);

export const getAdminUsers = async ({ status, search, page = 1, limit = 50 } = {}) => {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (status) params.set("status", status); if (search?.trim()) params.set("search", search.trim());
  const response = await apiClient.get(`/admin/users?${params.toString()}`); const data = response.data.data; const items = Array.isArray(data) ? data : data?.items || [];
  return { items, page: Number(data?.page || response.data.meta?.page || page), pageSize: Number(data?.pageSize || data?.limit || response.data.meta?.limit || limit), total: Number(data?.total || response.data.meta?.total || 0), hasNext: Boolean(data?.hasNext || data?.nextCursor || response.data.meta?.nextCursor || items.length === limit) };
};

export const getAdminUser = (userId) => apiClient.get(`/admin/users/${userId}`).then(unwrap);
export const suspendAdminUser = (userId, reason) => apiClient.post(`/admin/users/${userId}/suspend`, { reason }).then(unwrap);
export const reinstateAdminUser = (userId, reason) => apiClient.post(`/admin/users/${userId}/reinstate`, { reason }).then(unwrap);
export const deleteAdminUser = (userId, reason) => apiClient.delete(`/admin/users/${userId}`, { data: { reason } }).then(unwrap);
export const setAdminUserRole = (userId, input) => apiClient.post(`/admin/users/${userId}/roles`, input).then(unwrap);
