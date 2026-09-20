export const VIDEO_TRANSCODE_QUEUE = 'course-video.transcode';
export const VIDEO_TRANSCODE_RETRY_LIMIT = 5;
export const VIDEO_TRANSCODE_RETRY_DELAY_SECONDS = 30;
// pg-boss heartbeats detect a lost worker independently from the hard job
// expiry. Keep the latter above the five-hour FFmpeg timeout plus I/O overhead.
export const VIDEO_TRANSCODE_HEARTBEAT_SECONDS = 60;
export const VIDEO_TRANSCODE_EXPIRE_SECONDS = 6 * 60 * 60;
