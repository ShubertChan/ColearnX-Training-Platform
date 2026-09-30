import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PrivateAssetUploader from "../../src/components/uploads/PrivateAssetUploader";
import { uploadFileToPresignedUrl } from "../../src/utils/uploadFile";

vi.mock("../../src/utils/uploadFile", () => ({ uploadFileToPresignedUrl: vi.fn() }));

const missing = () => Object.assign(new Error("File has not reached storage."), { code: "UPLOAD_OBJECT_NOT_FOUND", status: 409 });
const network = () => Object.assign(new Error("Network interrupted."), { code: "NETWORK_ERROR", status: 0 });
const asset = { assetId: "asset-1", filename: "lesson.mp4", mediaType: "video/mp4", sizeBytes: 10, status: "ready" };

beforeEach(() => vi.resetAllMocks());

function setup(apiOverrides = {}) {
  const reservations = new Map();
  const api = {
    list: vi.fn().mockResolvedValue([]),
    request: vi.fn(async (_id, _file, options) => {
      const key = options?.requestKey || crypto.randomUUID();
      reservations.set(key, "asset-1");
      return { assetId: "asset-1", uploadUrl: "https://upload.example/file", requiredHeaders: {} };
    }),
    complete: vi.fn().mockResolvedValue(asset),
    remove: vi.fn().mockResolvedValue({}),
    ...apiOverrides,
  };
  render(<PrivateAssetUploader contentVersionId="version-1" assetApi={api} />);
  const file = new File(["test-video"], "lesson.mp4", { type: "video/mp4", lastModified: 123 });
  const select = () => fireEvent.change(screen.getByLabelText("Choose content files"), {
    target: { files: [file] },
  });
  return { api, reservations, select };
}

test("repeated interrupted uploads reuse one reservation and reset the progress", async () => {
  uploadFileToPresignedUrl.mockImplementation(({ onProgress }) => {
    onProgress({ loaded: 5, total: 10 });
    return { promise: Promise.reject(network()), abort: vi.fn() };
  });
  const { api, reservations, select } = setup({ complete: vi.fn().mockRejectedValue(missing()) });
  select();
  for (let attempt = 0; attempt < 6; attempt++) {
    await waitFor(() => expect(uploadFileToPresignedUrl).toHaveBeenCalledTimes(attempt + 1));
    await screen.findByText("Cannot reach the upload service. Check your connection and try again.");
    expect(screen.queryByRole("progressbar")).toBeNull();
    if (attempt < 5) fireEvent.click(screen.getByRole("button", { name: "Retry lesson.mp4" }));
  }
  expect(reservations.size).toBe(1);
  expect(api.remove).not.toHaveBeenCalled();
});

test("retry after a lost verification response recovers an uploaded file without uploading or deleting it again", async () => {
  uploadFileToPresignedUrl.mockReturnValue({ promise: Promise.resolve(), abort: vi.fn() });
  const { api, select } = setup({ complete: vi.fn().mockRejectedValueOnce(network()).mockResolvedValue(asset) });
  select();
  await screen.findByText("Cannot reach the upload service. Check your connection and try again.");
  fireEvent.click(screen.getByRole("button", { name: "Retry lesson.mp4" }));
  await screen.findByText("Uploaded");
  expect(uploadFileToPresignedUrl).toHaveBeenCalledTimes(1);
  expect(api.remove).not.toHaveBeenCalled();
});

test("a lost upload-intent response retries with the same request key", async () => {
  uploadFileToPresignedUrl.mockReturnValue({ promise: Promise.resolve(), abort: vi.fn() });
  const request = vi.fn().mockRejectedValueOnce(network()).mockResolvedValue({ assetId: "asset-1", uploadUrl: "https://upload.example/file", requiredHeaders: {} });
  const { select } = setup({ request, complete: vi.fn().mockRejectedValueOnce(missing()).mockResolvedValue(asset) });
  select();
  await screen.findByText("Cannot reach the upload service. Check your connection and try again.");
  fireEvent.click(screen.getByRole("button", { name: "Retry lesson.mp4" }));
  await screen.findByText("Uploaded");
  expect(request.mock.calls[0][2]?.requestKey).toBeTruthy();
  expect(request.mock.calls[1][2]?.requestKey).toBe(request.mock.calls[0][2]?.requestKey);
});

test("selecting the same failed file again reuses its reservation", async () => {
  uploadFileToPresignedUrl.mockReturnValue({ promise: Promise.reject(network()), abort: vi.fn() });
  const { reservations, select } = setup({ complete: vi.fn().mockRejectedValue(missing()) });
  select();
  await screen.findByText("Cannot reach the upload service. Check your connection and try again.");
  select();
  await waitFor(() => expect(uploadFileToPresignedUrl).toHaveBeenCalledTimes(2));
  await screen.findByText("Cannot reach the upload service. Check your connection and try again.");
  expect(screen.getAllByText("lesson.mp4")).toHaveLength(1);
  expect(reservations.size).toBe(1);
});

test("an uncertain storage check neither resends bytes nor deletes the file", async () => {
  uploadFileToPresignedUrl.mockReturnValue({ promise: Promise.reject(network()), abort: vi.fn() });
  const { api, select } = setup({ complete: vi.fn().mockRejectedValue(network()) });
  select();
  await screen.findByText("Cannot reach the upload service. Check your connection and try again.");
  fireEvent.click(screen.getByRole("button", { name: "Retry lesson.mp4" }));
  await waitFor(() => expect(api.complete).toHaveBeenCalledTimes(1));
  await screen.findByText("Cannot reach the upload service. Check your connection and try again.");
  expect(uploadFileToPresignedUrl).toHaveBeenCalledTimes(1);
  expect(api.remove).not.toHaveBeenCalled();
});

test("explicitly removing an active upload still aborts and removes its reservation", async () => {
  let rejectUpload;
  const abort = vi.fn(() => rejectUpload(new DOMException("Upload cancelled", "AbortError")));
  uploadFileToPresignedUrl.mockReturnValue({ promise: new Promise((_resolve, reject) => { rejectUpload = reject; }), abort });
  const { api, select } = setup();
  select();
  await screen.findByRole("progressbar");
  fireEvent.click(screen.getByRole("button", { name: "Remove lesson.mp4" }));
  await waitFor(() => expect(api.remove).toHaveBeenCalledWith("version-1", "asset-1"));
  expect(abort).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("lesson.mp4")).toBeNull();
});
