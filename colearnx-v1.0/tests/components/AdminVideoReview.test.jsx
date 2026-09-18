import { beforeEach, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AdminVideoReview from "../../src/components/video/AdminVideoReview";
import { getCourseVideo } from "../../src/api/video";

vi.mock("../../src/api/video", () => ({ getCourseVideo: vi.fn() }));
vi.mock("../../src/config/features", () => ({ hostedVideoEnabled: true }));
vi.mock("../../src/components/CourseVideoPlayer", () => ({ default: () => null }));
beforeEach(() => vi.clearAllMocks());

test("stale review queue cannot preview or approve a different current candidate", async () => {
  getCourseVideo.mockResolvedValue({ reviewVersionId: "new", versions: [
    { id: "old", status: "ready", durationSeconds: 100 }, { id: "new", status: "ready", durationSeconds: 100 },
  ] });
  render(<AdminVideoReview item={{ id: "course", reviewVideoVersionId: "old" }} onDecision={vi.fn()} />);
  await screen.findByText(/submitted video version changed/);
  expect(screen.getByRole("button", { name: "Preview ready video" }).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Approve", exact: true }).disabled).toBe(true);
});

test("ready status does not permit preview without a numeric verified duration", async () => {
  getCourseVideo.mockResolvedValue({ reviewVersionId: "new", versions: [{ id: "new", status: "ready", durationSeconds: "100" }] });
  render(<AdminVideoReview item={{ id: "course", reviewVideoVersionId: "new" }} onDecision={vi.fn()} />);
  await screen.findByText("Ready", { exact: true });
  expect(screen.getByText("Awaiting verified duration")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Preview ready video" }).disabled).toBe(true);
});
