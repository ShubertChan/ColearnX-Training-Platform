import { apiClient, mutateApi } from "./client.js";
import { listAllPages } from "./pagination.js";

const unwrap = (response) => response.data.data;

export const listCourses = (filters) => listAllPages("/courses", filters);
export const listContent = (filters) => listAllPages("/content", filters);
export const listMyListings = () => apiClient.get("/my/listings").then(unwrap);
export const createCourse = (input) => mutateApi("post", "/courses", input).then(unwrap);
export const submitCourse = (courseRunId) => mutateApi("post", `/courses/${courseRunId}/submit`).then(unwrap);
export const deleteCourseDraft = (courseRunId) => mutateApi("delete", `/courses/${courseRunId}/draft`).then(unwrap);
export const createContent = (input) => mutateApi("post", "/content", input).then(unwrap);
export const submitContent = (contentId) => mutateApi("post", `/content/${contentId}/submit`).then(unwrap);
export const deleteContentDraft = (contentId) => mutateApi("delete", `/content/${contentId}/draft`).then(unwrap);
