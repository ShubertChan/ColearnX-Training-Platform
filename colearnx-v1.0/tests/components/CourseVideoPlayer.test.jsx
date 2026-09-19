import { beforeEach, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import CourseVideoPlayer from "../../src/components/CourseVideoPlayer";
import { createPlaybackSession, createPreviewSession } from "../../src/api/video";
import { recordCourseProgress } from "../../src/api/courseDelivery";
import Hls from "hls.js";

vi.mock("../../src/api/video", () => ({ createPlaybackSession: vi.fn(), createPreviewSession: vi.fn() }));
vi.mock("../../src/api/courseDelivery", () => ({ recordCourseProgress: vi.fn() }));
vi.mock("hls.js", () => {
  class FakeHls {
    static instances = [];
    static isSupported = vi.fn(() => true);
    static Events = { ERROR: "error" };
    static ErrorTypes = { MEDIA_ERROR: "media" };
    constructor(config) { this.config = config; this.destroy = vi.fn(); FakeHls.instances.push(this); }
    on(_event, listener) { this.error = listener; }
    attachMedia() {} loadSource(url) { this.url = url; } recoverMediaError() {}
  }
  return { default: FakeHls };
});
const progress = { uniqueContentWatchedSeconds: 8, durationSeconds: 100, watchedRatio: 0.08 };
const record = { video: { id: "purchased-version", status: "ready" }, progress };
const session = () => ({ sessionId: "s", videoVersionId: "purchased-version", manifestUrl: "http://localhost:3000/media/master.m3u8", expiresAt: new Date(Date.now() + 60000).toISOString(), durationSeconds: 100, resumeAt: 8, authorization: { type: "cookie" } });
beforeEach(() => {
  vi.clearAllMocks(); Hls.instances = []; Hls.isSupported.mockReturnValue(true);
  createPlaybackSession.mockImplementation(async () => session());
  recordCourseProgress.mockResolvedValue(progress);
});
async function ready(props = {}) {
  const result = render(<CourseVideoPlayer orderItemId="order-item" record={record} {...props} />);
  await waitFor(() => expect(Hls.instances.length).toBe(1));
  const media = screen.getByLabelText("Course video"); fireEvent.loadedMetadata(media);
  return { ...result, media };
}
test("restores the server position and sends seek boundaries without local watched totals", async () => {
  const { media } = await ready(); expect(media.currentTime).toBe(8);
  media.currentTime = 60; fireEvent.seeking(media); fireEvent.seeked(media); fireEvent.playing(media);
  await waitFor(() => expect(recordCourseProgress).toHaveBeenCalledTimes(3));
  const bodies = recordCourseProgress.mock.calls.map(([, body]) => body);
  expect(bodies.map(b => b.event)).toEqual(["seeking", "seeked", "playing"]);
  expect(bodies.map(b => b.sequence)).toEqual([1, 2, 3]);
  expect(bodies.every(b => b.watchedSeconds === undefined && b.watchedRanges === undefined)).toBe(true);
  expect(screen.getByText(/8.000 of 100.000 seconds/)).toBeTruthy();
});
test("offline heartbeats preserve the last confirmed progress", async () => {
  recordCourseProgress.mockRejectedValue(Error("Offline"));
  const { media } = await ready(); media.currentTime = 70; fireEvent.playing(media);
  await screen.findByText(/Viewing progress could not be confirmed/);
  expect(screen.getByText(/8.000 of 100.000 seconds/)).toBeTruthy();
});
test("expired authorization renews and revoked purchases stop playback", async () => {
  createPlaybackSession.mockResolvedValueOnce({ ...session(), expiresAt: new Date(Date.now() + 4000).toISOString() }).mockRejectedValueOnce({ status: 403 });
  await ready();
  // Use the HLS 401 path to exercise immediate renewal without a wall-clock delay.
  act(() => Hls.instances[0].error("error", { response: { code: 401 } }));
  await screen.findByText(/unavailable for this account or purchase/);
  expect(createPlaybackSession).toHaveBeenCalledTimes(2);
  expect(Hls.instances[0].destroy).toHaveBeenCalled();
});
test("timer renews authorization before expiry", async () => {
  vi.useFakeTimers();
  render(<CourseVideoPlayer orderItemId="order-item" record={record} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  await act(async () => { await vi.advanceTimersByTimeAsync(48000); });
  expect(createPlaybackSession).toHaveBeenCalledTimes(2);
});
test("all HLS requests carry media authorization and reject foreign origins", async () => {
  await ready(); const xhr = { setRequestHeader: vi.fn() };
  Hls.instances[0].config.xhrSetup(xhr, "http://localhost:3000/media/segment.ts");
  expect(xhr.withCredentials).toBe(true);
  expect(() => Hls.instances[0].config.xhrSetup(xhr, "https://evil.example/segment.ts")).toThrow();
});
test("processing and mismatched version responses never attach a playable source", async () => {
  const { rerender } = render(<CourseVideoPlayer orderItemId="order-item" record={{ video: { id: "v", status: "transcoding" } }} />);
  expect(createPlaybackSession).not.toHaveBeenCalled();
  rerender(<CourseVideoPlayer orderItemId="order-item" record={{ video: { id: "different", status: "ready" } }} />);
  await screen.findByText(/Video playback was interrupted/); expect(Hls.instances).toHaveLength(0);
});
test("native HLS uses the same session and cookie authorization", async () => {
  Hls.isSupported.mockReturnValue(false);
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
  render(<CourseVideoPlayer orderItemId="order-item" record={record} />);
  const media = screen.getByLabelText("Course video");
  await waitFor(() => expect(media.src).toContain("master.m3u8"));
  expect(media.crossOrigin).toBe("use-credentials");
  expect(Hls.instances).toHaveLength(0);
});
test("unmount destroys HLS and sends a final pause observation", async () => {
  const { unmount } = await ready(); unmount();
  await waitFor(() => expect(recordCourseProgress).toHaveBeenCalled());
  expect(Hls.instances[0].destroy).toHaveBeenCalledTimes(1);
  expect(recordCourseProgress.mock.calls.at(-1)[1].event).toBe("pause");
});
test("admin preview never sends learner progress", async () => {
  createPreviewSession.mockResolvedValue(session());
  const { media } = await ready({ previewCourseId: "course", previewVersionId: "purchased-version" });
  fireEvent.playing(media); fireEvent.pause(media);
  expect(createPlaybackSession).not.toHaveBeenCalled(); expect(recordCourseProgress).not.toHaveBeenCalled();
});

test("renewal can recover a later expiration after the renewed video starts", async () => {
  const { media } = await ready();
  act(() => Hls.instances[0].error("error", { response: { code: 401 } }));
  await waitFor(() => expect(Hls.instances).toHaveLength(2));
  fireEvent.loadedMetadata(media); fireEvent.playing(media);
  act(() => Hls.instances[1].error("error", { response: { code: 401 } }));
  await waitFor(() => expect(createPlaybackSession).toHaveBeenCalledTimes(3));
});
test("decoder recovery preserves the current position rather than the initial resume offset", async () => {
  const { media } = await ready(); media.currentTime = 62;
  act(() => Hls.instances[0].error("error", { fatal: true, type: "media" }));
  media.currentTime = 0; fireEvent.loadedMetadata(media);
  expect(media.currentTime).toBe(62);
});
test("expired heartbeat sessions renew instead of permanently revoking playback", async () => {
  const { media } = await ready();
  recordCourseProgress.mockRejectedValueOnce({ status: 401, code: "PLAYBACK_EXPIRED" });
  fireEvent.playing(media);
  await waitFor(() => expect(createPlaybackSession).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(/unavailable for this account or purchase/)).toBe(null);
});

test("a playback-expired creation response remains retryable even when its HTTP status is 401", async () => {
  createPlaybackSession.mockRejectedValueOnce({ status: 401, code: "PLAYBACK_EXPIRED" });
  render(<CourseVideoPlayer orderItemId="order-item" record={record} />);
  await screen.findByText("Playback authorisation expired. Renew it to continue.");
  expect(screen.getByRole("button", { name: "Retry playback" })).toBeTruthy();
  expect(screen.queryByText(/unavailable for this account or purchase/)).toBe(null);
});
