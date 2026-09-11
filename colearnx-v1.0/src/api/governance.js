import { apiClient } from "./client.js";

const unwrap = (response) => response.data.data;
export const getMyRoleApplications = () => apiClient.get("/role-applications/me").then(unwrap);
export const createRoleApplication = (input) => apiClient.post("/role-applications", input).then(unwrap);
export const getMyTrainerCertifications = () => apiClient.get("/trainer-certifications/me").then(unwrap);
export const createTrainerCertification = (input) => apiClient.post("/trainer-certifications", input).then(unwrap);

async function listPages(path, { status, limit = 100 } = {}) {
  const items = []; const seen = new Set();
  for (let page = 1; page <= 10_000; page += 1) {
    const params = new URLSearchParams({ limit: String(limit), page: String(page) }); if (status) params.set("status", status);
    const data = await apiClient.get(`${path}?${params.toString()}`).then(unwrap); const batch = Array.isArray(data) ? data : data?.items || []; let added = 0;
    batch.forEach((item) => { if (seen.has(item.id)) return; seen.add(item.id); items.push(item); added += 1; });
    if (batch.length < limit || added === 0) break;
  }
  return items;
}

export const getAdminRoleApplications = (input) => listPages("/admin/role-applications", input);
export const decideRoleApplication = (applicationId, input) => apiClient.post(`/admin/role-applications/${applicationId}/decision`, input).then(unwrap);
export const getAdminTrainerCertifications = () => listPages("/admin/trainer-certifications");
export const decideTrainerCertification = (certificationId, input) => apiClient.post(`/admin/trainer-certifications/${certificationId}/decision`, input).then(unwrap);
