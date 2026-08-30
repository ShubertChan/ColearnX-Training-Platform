import { apiClient } from "./client";

const unwrap = (response) => response.data.data;

export const getMyRoleApplications = () =>
  apiClient.get("/role-applications/me").then(unwrap);

export const createRoleApplication = (input) =>
  apiClient.post("/role-applications", input).then(unwrap);

export const getMyTrainerCertifications = () =>
  apiClient.get("/trainer-certifications/me").then(unwrap);

export const createTrainerCertification = (input) =>
  apiClient.post("/trainer-certifications", input).then(unwrap);

export const getAdminRoleApplications = () =>
  apiClient.get("/admin/role-applications?limit=100").then(unwrap);

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
