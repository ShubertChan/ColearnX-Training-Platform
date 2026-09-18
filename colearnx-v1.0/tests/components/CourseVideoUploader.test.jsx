import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CourseVideoUploader from "../../src/components/uploads/CourseVideoUploader";
import { getCourseVideo, abortVideoParts } from "../../src/api/video";
import { uploadVideo } from "../../src/utils/videoUpload";

vi.mock("../../src/context/PlatformContext", () => ({ usePlatform: () => ({ profile: { id: "trainer" } }) }));
vi.mock("../../src/api/video", () => ({ getCourseVideo: vi.fn(), abortVideoParts: vi.fn(), createVideoUpload: vi.fn(), deleteVideo: vi.fn(), retryVideo: vi.fn() }));
vi.mock("../../src/utils/videoUpload", async original => ({ ...await original(), identifyVideoFile: async file => ({ name: file.name, size: file.size, lastModified: file.lastModified, fingerprint: "hash" }), uploadVideo: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); getCourseVideo.mockResolvedValue({ canUpload: true, canSubmit: false, versions: [] }); });
test("file upload completing still cannot submit a queued video", async () => {
  const onStateChange = vi.fn(); uploadVideo.mockResolvedValue("v");
  render(<CourseVideoUploader courseId="course" onStateChange={onStateChange} />);
  const input = await screen.findByLabelText("Choose course video");
  getCourseVideo.mockResolvedValue({ canUpload: false, canSubmit: false, reviewVersionId: "v", versions: [{ id: "v", status: "queued", versionNo: 1 }] });
  fireEvent.change(input, { target: { files: [new File(["x"], "course.mp4", { type: "video/mp4" })] } });
  await screen.findByText("Queued for processing");
  expect(onStateChange.mock.calls.at(-1)[0].ready).toBe(false);
});
test("reload exposes original-file recovery and cancellation even when new uploads are disabled", async () => {
  localStorage.setItem("colearnx-video-upload:trainer:course", JSON.stringify({ requestKey: "k", versionId: "v", file: { name: "course.mp4", fingerprint: "hash" } }));
  getCourseVideo.mockResolvedValue({ canUpload: false, versions: [{ id: "v", status: "upload_pending", versionNo: 1 }] });
  abortVideoParts.mockResolvedValue({});
  render(<CourseVideoUploader courseId="course" />);
  await waitFor(() => expect(screen.getByText("Cancel upload").disabled).toBe(false));
  expect(screen.getByLabelText("Choose original video to resume")).toBeTruthy();
  fireEvent.click(screen.getByText("Cancel upload"));
  await waitFor(() => expect(localStorage.getItem("colearnx-video-upload:trainer:course")).toBe(null));
  expect(abortVideoParts).toHaveBeenCalledWith("course", "v");
});
test("replacement is explicit and existing order versions expose no deletion action", async () => {
  getCourseVideo.mockResolvedValue({ canUpload: true, versions: [{ id: "old", status: "ready", versionNo: 1, durationSeconds: 30, hasOrderReferences: true, canDelete: true }] });
  render(<CourseVideoUploader courseId="course" />);
  fireEvent.change(await screen.findByLabelText("Choose course video"), { target: { files: [new File(["x"], "new.mp4", { type: "video/mp4" })] } });
  expect(screen.getByRole("dialog")).toBeTruthy(); expect(uploadVideo).not.toHaveBeenCalled();
  expect(screen.queryByText("Delete unused version")).toBe(null);
  fireEvent.click(screen.getByText("Upload new version"));
  await waitFor(() => expect(uploadVideo).toHaveBeenCalledTimes(1));
});

test("successful status refresh does not erase an upload failure", async () => {
  uploadVideo.mockRejectedValue({ code: "UPLOAD_EXPIRED" });
  render(<CourseVideoUploader courseId="course" />);
  fireEvent.change(await screen.findByLabelText("Choose course video"), { target: { files: [new File(["x"], "new.mp4", { type: "video/mp4" })] } });
  await screen.findByText(/This upload expired/);
  fireEvent.click(screen.getByText("Refresh video status"));
  await waitFor(() => expect(getCourseVideo.mock.calls.length).toBe(2));
  expect(screen.queryByText(/This upload expired/)).not.toBe(null);
});

test("disabled browser storage does not prevent a live upload", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Storage blocked"); });
  uploadVideo.mockResolvedValue("v");
  render(<CourseVideoUploader courseId="course" />);
  fireEvent.change(await screen.findByLabelText("Choose course video"), { target: { files: [new File(["x"], "new.mp4", { type: "video/mp4" })] } });
  await waitFor(() => expect(uploadVideo).toHaveBeenCalledTimes(1));
});
