import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CourseEditorPage from "../../src/pages/CourseEditorPage";
import { createCourse } from "../../src/api/catalog";

const features = vi.hoisted(() => ({ video: true }));
const platform = vi.hoisted(() => ({ refreshMyListings: vi.fn(), notify: vi.fn() }));
vi.mock("../../src/context/PlatformContext", () => ({
  usePlatform: () => platform,
}));
vi.mock("../../src/api/catalog", () => ({ createCourse: vi.fn(), submitCourse: vi.fn() }));
vi.mock("../../src/api/uploads", () => ({ courseAssetApi: {} }));
vi.mock("../../src/config/features", () => ({ get hostedVideoEnabled() { return features.video; } }));
vi.mock("../../src/components/uploads/CourseVideoUploader", () => ({ default: () => <div>Video uploader</div> }));
vi.mock("../../src/components/uploads/PrivateAssetUploader", () => ({ default: () => <div>Attachment uploader</div> }));

beforeEach(() => {
  vi.clearAllMocks();
  features.video = true;
  platform.refreshMyListings.mockResolvedValue([]);
  createCourse.mockResolvedValue({ id: "draft-course" });
});

function renderEditor() {
  return render(<MemoryRouter><CourseEditorPage /></MemoryRouter>);
}

function fillCoreFields() {
  fireEvent.change(screen.getByLabelText("Course title"), { target: { value: "Course title" } });
  fireEvent.change(screen.getByLabelText("Public description"), { target: { value: "Course description" } });
  fireEvent.change(screen.getByLabelText("Price in points"), { target: { value: "20" } });
}

test("a video draft never falls back to general file uploads when hosted video is disabled", async () => {
  features.video = false;
  platform.refreshMyListings.mockResolvedValue([{ id: "course", kind: "course", status: "Draft", title: "Video course", description: "Video only", price: 20, onlineVideo: true, deliveryModes: ["cloud"] }]);
  render(<MemoryRouter initialEntries={["/?draft=course"]}><CourseEditorPage /></MemoryRouter>);
  await screen.findByText("Video uploads are not enabled for this deployment.");
  expect(screen.queryByText("Attachment uploader")).toBeNull();
  expect(screen.queryByText("Video uploader")).toBeNull();
  expect(screen.getByRole("button", { name: "Submit for administrator review" }).disabled).toBe(true);
});

test("video course saves the existing video delivery contract", async () => {
  renderEditor();
  expect(screen.getByRole("radio", { name: /Video course/ }).checked).toBe(true);
  expect(screen.getByRole("radio", { name: /Instructor-led course/ }).checked).toBe(false);
  fireEvent.click(screen.getByRole("radio", { name: /Instructor-led course/ }));
  fireEvent.change(screen.getByLabelText("Live-session link (optional)"), { target: { value: "https://meeting.example/live" } });
  fireEvent.click(screen.getByRole("radio", { name: /Video course/ }));
  expect(screen.queryByLabelText("Live-session link (optional)")).toBeNull();
  expect(screen.getByLabelText("Start time (optional)").required).toBe(false);
  fillCoreFields();
  fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
  await waitFor(() => expect(createCourse).toHaveBeenCalledTimes(1));
  expect(createCourse).toHaveBeenCalledWith(expect.objectContaining({
    deliveryModes: ["cloud"], progressTrackingType: "online_video", fulfilmentInstructions: null, trainerContact: null, joinUrl: null, startsAt: null,
  }));
});

test("instructor-led selection keeps exactly one delivery mode and sends offline announcement details", async () => {
  renderEditor();
  fireEvent.click(screen.getByRole("radio", { name: /Instructor-led course/ }));
  fireEvent.click(screen.getByRole("radio", { name: /Offline — arrange directly/ }));
  expect(screen.getByRole("radio", { name: /Online — live session/ }).checked).toBe(false);
  expect(screen.getByRole("radio", { name: /Offline — arrange directly/ }).checked).toBe(true);
  expect(screen.queryByLabelText("Live-session link (optional)")).toBeNull();
  fillCoreFields();
  fireEvent.change(screen.getByLabelText("Course announcement for purchasers"), { target: { value: "Please contact me to choose a venue." } });
  fireEvent.change(screen.getByLabelText("Trainer contact for purchasers"), { target: { value: "trainer@example.test" } });
  fireEvent.change(screen.getByLabelText("Start time (required)"), { target: { value: "2026-10-01T10:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
  await waitFor(() => expect(createCourse).toHaveBeenCalledTimes(1));
  expect(createCourse).toHaveBeenCalledWith(expect.objectContaining({
    deliveryModes: ["local"], progressTrackingType: "none", fulfilmentInstructions: "Please contact me to choose a venue.", trainerContact: "trainer@example.test", joinUrl: null, startsAt: new Date("2026-10-01T10:00").toISOString(),
  }));
});

test("online instructor-led selection sends only the live delivery mode and an optional session link", async () => {
  renderEditor();
  fireEvent.click(screen.getByRole("radio", { name: /Instructor-led course/ }));
  expect(screen.getByRole("radio", { name: /Online — live session/ }).checked).toBe(true);
  fillCoreFields();
  fireEvent.change(screen.getByLabelText("Course announcement for purchasers"), { target: { value: "Join ten minutes before the live class." } });
  fireEvent.change(screen.getByLabelText("Trainer contact for purchasers"), { target: { value: "trainer@example.test" } });
  fireEvent.change(screen.getByLabelText("Live-session link (optional)"), { target: { value: "https://meeting.example/live" } });
  fireEvent.change(screen.getByLabelText("Start time (required)"), { target: { value: "2026-10-01T10:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
  await waitFor(() => expect(createCourse).toHaveBeenCalledTimes(1));
  expect(createCourse).toHaveBeenCalledWith(expect.objectContaining({
    deliveryModes: ["live"], progressTrackingType: "none", joinUrl: "https://meeting.example/live", startsAt: new Date("2026-10-01T10:00").toISOString(),
  }));
});

test.each([/Online — live session/, /Offline — arrange directly/])("instructor-led %s rejects a missing start time before calling the API", (teachingFormat) => {
  renderEditor();
  fireEvent.click(screen.getByRole("radio", { name: /Instructor-led course/ }));
  fireEvent.click(screen.getByRole("radio", { name: teachingFormat }));
  fillCoreFields();
  fireEvent.change(screen.getByLabelText("Course announcement for purchasers"), { target: { value: "Contact me for the meeting arrangements." } });
  fireEvent.change(screen.getByLabelText("Trainer contact for purchasers"), { target: { value: "trainer@example.test" } });
  expect(screen.getByLabelText("Start time (required)").required).toBe(true);
  fireEvent.submit(screen.getByRole("button", { name: "Create draft" }).closest("form"));
  expect(createCourse).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("Enter a confirmed start time");
});
