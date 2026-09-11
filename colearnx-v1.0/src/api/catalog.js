import { apiClient } from "./client.js";
import { listAllPages } from "./pagination.js";

const unwrap = (response) => response.data.data;

export const listCourses = (filters) => listAllPages("/courses", filters);
export const listContent = (filters) => listAllPages("/content", filters);
export const listMyListings = () => apiClient.get("/my/listings").then(unwrap);
export const createCourse = (input) => apiClient.post("/courses", input).then(unwrap);
export const submitCourse = (courseRunId) => apiClient.post(`/courses/${courseRunId}/submit`).then(unwrap);
export const deleteCourseDraft = (courseRunId) => apiClient.delete(`/courses/${courseRunId}/draft`).then(unwrap);
export const createContent = (input) => apiClient.post("/content", input).then(unwrap);
export const submitContent = (contentId) => apiClient.post(`/content/${contentId}/submit`).then(unwrap);
export const deleteContentDraft = (contentId) => apiClient.delete(`/content/${contentId}/draft`).then(unwrap);
