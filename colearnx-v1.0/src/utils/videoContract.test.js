import test from "node:test";
import assert from "node:assert/strict";
import { canSubmitVideo, confirmedProgress, isVideoAsset, mediaUrl, validatePlaybackSession, videoError, videoSummary } from "./videoContract.js";

test("review readiness follows the candidate version, never an older ready video", () => {
  const data = { canSubmit: true, reviewVersionId: "new", versions: [{ id: "old", status: "ready", durationSeconds: 10 }, { id: "new", status: "transcoding" }] };
  assert.equal(canSubmitVideo(data), false);
  data.versions[1] = { id: "new", status: "ready", durationSeconds: 14400 };
  assert.equal(canSubmitVideo(data), true);
  data.versions[1].durationSeconds = 14400.001;
  assert.equal(canSubmitVideo(data), false);
});
test("only the shared server state enum is accepted", () => {
  assert.throws(() => videoSummary({ versions: [{ id: "v", status: "processing" }] }));
  assert.equal(videoSummary({ versions: [{ id: "v", status: "superseded" }] }).versions.length, 1);
});
test("legacy totals and incomplete progress do not appear as confirmed unique viewing", () => {
  assert.equal(confirmedProgress({ watchedSeconds: 100, totalDurationSeconds: 1000 }), null);
  assert.equal(confirmedProgress({ uniqueContentWatchedSeconds: 0, durationSeconds: 1 }), null);
  assert.equal(confirmedProgress({ uniqueContentWatchedSeconds: 11, durationSeconds: 10, watchedRatio: 1 }), null);
  assert.equal(confirmedProgress({ uniqueContentWatchedSeconds: 10.001, durationSeconds: 100, watchedRatio: 0.10001 }).uniqueContentWatchedSeconds, 10.001);
});
test("media credentials only go to exact configured secure origins", () => {
  assert.equal(mediaUrl("https://media.example/a", "https://media.example", "https://app.example"), "https://media.example/a");
  for (const url of ["https://media.example.evil/a", "https://secret@media.example/a", "javascript:alert(1)", "http://media.example/a"]) assert.equal(mediaUrl(url, "https://media.example", "https://app.example"), "");
  assert.equal(mediaUrl("https://bucket.r2.dev/master.m3u8", "https://bucket.r2.dev", "https://app.example"), "");
});
test("playback rejects changed purchase bindings and stale authorisations", () => {
  const session = { sessionId: "s", videoVersionId: "old", manifestUrl: "http://localhost/hls/master.m3u8", durationSeconds: 10, resumeAt: 2, expiresAt: new Date(Date.now() + 60000).toISOString(), authorization: { type: "cookie" } };
  assert.equal(validatePlaybackSession(session, "old"), session);
  assert.throws(() => validatePlaybackSession(session, "current"));
  assert.throws(() => validatePlaybackSession({ ...session, expiresAt: "2000-01-01" }));
  for (const manifestUrl of [undefined, null, "", "   "]) assert.throws(() => validatePlaybackSession({ ...session, manifestUrl }));
  assert.throws(() => validatePlaybackSession({ ...session, durationSeconds: "10" }));
});
test("sources never become download entries and error text never includes signed URLs", () => {
  assert.equal(isVideoAsset({ assetPurpose: "video_source" }), true);
  assert.equal(isVideoAsset({ purpose: "online_video" }), true);
  assert.equal(isVideoAsset({ purpose: "attachment" }), false);
  assert.ok(!videoError({ message: "https://private/?token=secret" }).includes("secret"));
});
