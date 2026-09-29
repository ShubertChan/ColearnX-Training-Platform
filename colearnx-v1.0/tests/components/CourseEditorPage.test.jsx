import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CourseEditorPage from "../../src/pages/CourseEditorPage";
import { createCourse } from "../../src/api/catalog";

vi.mock("../../src/context/PlatformContext", () => ({
  usePlatform: () => ({ refreshMyListings: vi.fn().mockResolvedValue([]), notify: vi.fn() }),
}));
vi.mock("../../src/api/catalog", () => ({ createCourse: vi.fn(), submitCourse: vi.fn() }));
vi.mock("../../src/api/uploads", () => ({ courseAssetApi: {} }));
vi.mock("../../src/config/features", () => ({ hostedVideoEnabled: true }));
vi.mock("../../src/components/uploads/CourseVideoUploader", () => ({ default: () => <div>Video uploader</div> }));
vi.mock("../../src/components/uploads/PrivateAssetUploader", () => ({ default: () => <div>Attachment uploader</div> }));

beforeEach(() => {
  vi.clearAllMocks();
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

test("video course saves the existing video delivery contract", async () => {
  renderEditor();
  expect(screen.getByRole("radio", { name: /Video course/ }).checked).toBe(true);
  expect(screen.getByRole("radio", { name: /Instructor-led course/ }).checked).toBe(false);
  fireEvent.click(screen.getByRole("radio", { name: /Instructor-led course/ }));
  fireEvent.change(screen.getByLabelText("Live-session link (optional)"), { target: { value: "https://meeting.example/live" } });
  fireEvent.click(screen.getByRole("radio", { name: /Video course/ }));
  expect(screen.queryByLabelText("Live-session link (optional)")).toBeNull();
  fillCoreFields();
  fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
  await waitFor(() => expect(createCourse).toHaveBeenCalledTimes(1));
  expect(createCourse).toHaveBeenCalledWith(expect.objectContaining({
    deliveryModes: ["cloud"], progressTrackingType: "online_video", fulfilmentInstructions: null, trainerContact: null, joinUrl: null,
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
  fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
  await waitFor(() => expect(createCourse).toHaveBeenCalledTimes(1));
  expect(createCourse).toHaveBeenCalledWith(expect.objectContaining({
    deliveryModes: ["local"], progressTrackingType: "none", fulfilmentInstructions: "Please contact me to choose a venue.", trainerContact: "trainer@example.test", joinUrl: null,
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
  fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
  await waitFor(() => expect(createCourse).toHaveBeenCalledTimes(1));
  expect(createCourse).toHaveBeenCalledWith(expect.objectContaining({
    deliveryModes: ["live"], progressTrackingType: "none", joinUrl: "https://meeting.example/live",
  }));
});
