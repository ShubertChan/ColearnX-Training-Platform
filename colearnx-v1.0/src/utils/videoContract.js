export const VIDEO_STATUSES = Object.freeze(["upload_pending", "queued", "transcoding", "ready", "failed", "superseded", "delete_pending", "deleted"]);
export const JOB_STATUSES = Object.freeze(["queued", "running", "succeeded", "retryable_failed", "dead"]);
export const HEARTBEAT_EVENTS = Object.freeze(["playing", "pause", "seeking", "seeked", "ended"]);
export const MAX_VIDEO_SECONDS = 14400;
export const VIDEO_STATUS_LABELS = Object.freeze({ upload_pending: "Awaiting upload", queued: "Queued for processing", transcoding: "Processing video", ready: "Ready", failed: "Processing failed", superseded: "Previous version", delete_pending: "Deletion pending", deleted: "Deleted" });
export const VIDEO_ERRORS = Object.freeze({
  VIDEO_TOO_LONG: "This video exceeds the 4-hour limit. Choose a shorter video.",
  VIDEO_INVALID_SOURCE: "This file could not be processed. Choose a valid video file.",
  VIDEO_NOT_READY: "This video is still being prepared. Try again after processing finishes.",
  VIDEO_VERSION_REFERENCED: "This version belongs to existing orders and cannot be deleted.",
  PLAYBACK_EXPIRED: "Your playback authorisation expired. Renew it to continue.",
  PLAYBACK_UNAUTHORISED: "This purchase no longer has permission to play this video.",
  UPLOAD_EXPIRED: "This upload expired. Cancel it and choose the file again.",
  HOSTED_VIDEO_DISABLED: "Online video is temporarily unavailable.",
});
export function videoError(error) {
  return VIDEO_ERRORS[error?.code] || (error?.status === 401 || error?.status === 403
    ? "You do not have permission for this video action."
    : error?.status === 409 ? "The video changed or this action is not allowed. Refresh its status."
      : "The video service is unavailable. Check your connection and retry.");
}
export function videoSummary(data) {
  if (!data || !Array.isArray(data.versions) || data.versions.some(v => !v.id || !VIDEO_STATUSES.includes(v.status))) throw new Error("Invalid video contract");
  return data;
}
export function confirmedProgress(data) {
  const value = data?.progress || data;
  const fields = [value?.uniqueContentWatchedSeconds, value?.durationSeconds, value?.watchedRatio];
  if (fields.some(v => typeof v !== "number" || !Number.isFinite(v)) || fields[0] < 0 || fields[1] <= 0 || fields[0] > fields[1] || fields[2] < 0 || fields[2] > 1) return null;
  return { uniqueContentWatchedSeconds: fields[0], durationSeconds: fields[1], watchedRatio: fields[2] };
}
export function formatVideoDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "Awaiting verified duration";
  const n = Math.floor(seconds);
  return `${Math.floor(n / 3600)}:${String(Math.floor(n % 3600 / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}
export const isVideoAsset = asset => ["video_source", "online_video", "video_hls", "hls"].includes(asset.assetPurpose || asset.purpose);
export function heartbeatBody(input) {
  const { sessionId, sequence, event, positionSeconds, playbackRate, clientMonotonicMs } = input || {};
  if (!sessionId || !Number.isSafeInteger(sequence) || sequence < 1 || !HEARTBEAT_EVENTS.includes(event)
    || !Number.isFinite(positionSeconds) || positionSeconds < 0 || !Number.isFinite(playbackRate) || playbackRate <= 0
    || !Number.isFinite(clientMonotonicMs) || clientMonotonicMs < 0) throw new Error("Invalid playback observation");
  return { sessionId, sequence, event, positionSeconds, playbackRate, clientMonotonicMs };
}
export function canSubmitVideo(summary) {
  const version = summary?.versions?.find(v => v.id === summary.reviewVersionId);
  return Boolean(summary?.canSubmit === true && version?.status === "ready" && Number.isFinite(version.durationSeconds) && version.durationSeconds > 0 && version.durationSeconds <= MAX_VIDEO_SECONDS);
}

// Only deployment-configured origins may receive media credentials.
export function mediaUrl(value, origins = import.meta.env?.VITE_MEDIA_ORIGINS || "", base = globalThis.location?.origin || "http://localhost") {
  try {
    if (typeof value !== "string" || !value.trim()) return "";
    const url = new URL(value, base);
    if (url.hostname.endsWith(".r2.dev") || url.hostname.endsWith(".r2.cloudflarestorage.com")) return "";
    const allowed = new Set([new URL(base).origin, ...origins.split(",").map(s => s.trim()).filter(Boolean)]);
    const local = ["localhost", "127.0.0.1"].includes(url.hostname);
    return allowed.has(url.origin) && (url.protocol === "https:" || (local && url.protocol === "http:")) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}
export function validatePlaybackSession(session, expectedVersionId) {
  if (!session?.sessionId || !session.videoVersionId || (expectedVersionId && session.videoVersionId !== expectedVersionId)
    || !mediaUrl(session.manifestUrl) || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now() + 1000
    || !Number.isFinite(session.durationSeconds) || !(session.durationSeconds > 0 && session.durationSeconds <= MAX_VIDEO_SECONDS)
    || !Number.isFinite(session.resumeAt) || session.resumeAt < 0 || session.resumeAt > session.durationSeconds
    || !["cookie", "header"].includes(session.authorization?.type)) throw new Error("Invalid playback contract");
  if (session.authorization.type === "header" && !session.authorization.token) throw new Error("Missing playback token");
  return session;
}
/**
 * @typedef {'upload_pending'|'queued'|'transcoding'|'ready'|'failed'|'superseded'|'delete_pending'|'deleted'} VideoStatus
 * @typedef {'queued'|'running'|'succeeded'|'retryable_failed'|'dead'} TranscodeJobStatus
 * @typedef {'playing'|'pause'|'seeking'|'seeked'|'ended'} HeartbeatEvent
 * @typedef {{sessionId:string, sequence:number, event:HeartbeatEvent, positionSeconds:number, playbackRate:number, clientMonotonicMs:number}} VideoHeartbeat
 * @typedef {{uniqueContentWatchedSeconds:number, durationSeconds:number, watchedRatio:number}} ConfirmedVideoProgress
 */
