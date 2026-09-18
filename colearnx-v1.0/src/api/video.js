import { apiClient } from "./client.js";
import { videoSummary } from "../utils/videoContract.js";

const unwrap = response => response.data.data;
const course = id => `/courses/${encodeURIComponent(id)}`;
const version = (id, versionId) => `${course(id)}/video-versions/${encodeURIComponent(versionId)}`;
const options = (requestKey = crypto.randomUUID(), signal) => ({ headers: { "Idempotency-Key": requestKey }, signal });
export const getCourseVideo = (id, signal) => apiClient.get(`${course(id)}/video`, { signal }).then(unwrap).then(videoSummary);
export const createVideoUpload = (id, file, requestKey, signal) => apiClient.post(`${course(id)}/video-upload-intents`, {
  filename: file.name, mediaType: file.type || "application/octet-stream", sizeBytes: file.size,
}, options(requestKey, signal)).then(unwrap);
export const completeVideoUpload = (id, versionId, requestKey, signal) => apiClient.post(`${version(id, versionId)}/complete`, {}, options(requestKey, signal)).then(unwrap);
export const retryVideo = (id, versionId, requestKey) => apiClient.post(`${version(id, versionId)}/retry`, {}, options(requestKey)).then(unwrap);
export const deleteVideo = (id, versionId) => apiClient.delete(version(id, versionId), options()).then(unwrap);

// Extension contracts awaiting backend agreement are documented in HOSTED_VIDEO_HANDOFF.md.
export const listVideoParts = (id, versionId, signal) => apiClient.get(`${version(id, versionId)}/multipart`, { signal }).then(unwrap);
export const signVideoPart = (id, versionId, partNumber, signal) => apiClient.post(`${version(id, versionId)}/multipart/sign`, { partNumber }, options(undefined, signal)).then(unwrap);
export const finishVideoParts = (id, versionId, parts, requestKey, signal) => apiClient.post(`${version(id, versionId)}/multipart/complete`, { parts }, options(requestKey, signal)).then(unwrap);
export const abortVideoParts = (id, versionId) => apiClient.delete(`${version(id, versionId)}/multipart`, options()).then(unwrap);
export const createPlaybackSession = (orderItemId, requestKey, signal) => apiClient.post(`/order-items/${encodeURIComponent(orderItemId)}/playback-sessions`, {}, options(requestKey, signal)).then(unwrap);
export const createPreviewSession = (courseId, versionId, requestKey, signal) => apiClient.post(`/admin/course-runs/${encodeURIComponent(courseId)}/video-versions/${encodeURIComponent(versionId)}/playback-sessions`, {}, options(requestKey, signal)).then(unwrap);
export const getVideoOperations = signal => apiClient.get("/admin/video-operations", { signal }).then(unwrap);
