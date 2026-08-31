import { apiClient } from "./client.js";

const unwrap = (response) => response.data.data;

export const getMyRoleApplications = () =>
  apiClient.get("/role-applications/me").then(unwrap);

export const createRoleApplication = (input) =>
  apiClient.post("/role-applications", input).then(unwrap);

export const getMyTrainerCertifications = () =>
  apiClient.get("/trainer-certifications/me").then(unwrap);

export const createTrainerCertification = (input) =>
  apiClient.post("/trainer-certifications", input).then(unwrap);

export const getAdminRoleApplications = async ({ status, limit = 100 } = {}) => {
  const applications = [];
  const seen = new Set();
  for (let page = 1; page <= 10_000; page += 1) {
    const params = new URLSearchParams({ limit: String(limit), page: String(page) });
    if (status) params.set("status", status);
    const batch = await apiClient.get(`/admin/role-applications?${params.toString()}`).then(unwrap);
    let added = 0;
    batch.forEach((application) => {
      if (seen.has(application.id)) return;
      seen.add(application.id);
      applications.push(application);
      added += 1;
    });
    if (batch.length < limit || added === 0) break;
  }
  return applications;
};

export const decideRoleApplication = (applicationId, input) =>
  apiClient
    .post(`/admin/role-applications/${applicationId}/decision`, input)
    .then(unwrap);

export const getAdminTrainerCertifications = () =>
  apiClient.get("/admin/trainer-certifications?limit=100").then(unwrap);

export const decideTrainerCertification = (certificationId, input) =>
  apiClient
    .post(`/admin/trainer-certifications/${certificationId}/decision`, input)
    .then(unwrap);
