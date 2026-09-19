export function canSubmitCourse({ files, video, onlineVideo = false, needsFile = false, videoEnabled = false }) {
  if (!files || files.loading || files.error || files.activeCount > 0 || files.unresolvedCount > 0 || (needsFile && !files.readyCount)) return false;
  return !onlineVideo || Boolean(videoEnabled && video?.ready && !video.busy && !video.error);
}
export function attachmentInventory(assets) {
  return { loading: false, error: false, activeCount: 0, readyCount: assets.filter(asset => asset.status === "ready").length, unresolvedCount: assets.filter(asset => asset.status !== "ready").length };
}
