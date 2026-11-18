import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { CourseResourceEditor, CourseReuseReport, PurchasePermissions } from "../../src/components/publishing/CourseReuse";
import * as api from "../../src/api/workflows";

vi.mock("../../src/api/workflows", () => ({
  listCreatorCourseReuse: vi.fn(), listReuseLicences: vi.fn(), setReuseLicence: vi.fn(),
  listCourseResourceOptions: vi.fn(), validateCourseResources: vi.fn(), saveCourseResources: vi.fn(),
  serviceMessage: e => e.message,
}));
beforeEach(() => vi.resetAllMocks());

test("a creator can distinguish zero, a failed read and a refreshed count", async () => {
  const item = { id: "one", title: "Workbook", courseCount: 0 };
  api.listCreatorCourseReuse.mockRejectedValueOnce(new Error("Service unavailable"))
    .mockResolvedValueOnce([item]).mockResolvedValueOnce([{ ...item, courseCount: 1 }]);
  render(<CourseReuseReport />);
  expect((await screen.findByRole("alert")).textContent).toBe("Service unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry records" }));
  const row = () => screen.getByRole("row", { name: /Workbook/ });
  await waitFor(() => expect(within(row()).getByRole("cell").textContent).toBe("0"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh counts" }));
  await waitFor(() => expect(within(row()).getByRole("cell").textContent).toBe("1"));
});

test("granting requires purchase-specific confirmation and a successful server response", async () => {
  const purchase = { id: "licence", buyerLabel: "Alex", orderNo: "CX-202", purchasedAt: "2026-01-03T10:00:00Z", version: 3, courseReuseAllowed: false };
  api.listReuseLicences.mockResolvedValueOnce([purchase]).mockResolvedValueOnce([{ ...purchase, courseReuseAllowed: true }]);
  api.setReuseLicence.mockRejectedValueOnce(new Error("Temporarily unavailable")).mockResolvedValueOnce({ courseReuseAllowed: true });
  render(<PurchasePermissions contentId="content" title="Workbook" />);
  fireEvent.click(await screen.findByRole("button", { name: "Grant reuse" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("Alex");
  expect(dialog.textContent).toContain("CX-202");
  expect(dialog.textContent).toContain("Version 3");
  expect(api.setReuseLicence).not.toHaveBeenCalled();
  const confirm = within(dialog).getByRole("button", { name: "Grant reuse" });
  fireEvent.click(confirm);
  expect((await within(dialog).findByRole("alert")).textContent).toBe("Temporarily unavailable");
  expect(screen.getByText("Personal access")).toBeTruthy();
  fireEvent.click(confirm);
  expect(await screen.findByText("Reuse granted")).toBeTruthy();
  expect(api.setReuseLicence).toHaveBeenLastCalledWith("content", "licence", true);
});

test("a trainer can remove the last saved reference after the permission was withdrawn", async () => {
  const option = { id: "v1", title: "Workbook", version: 1, selected: true, courseReuseAllowed: false };
  api.listCourseResourceOptions.mockResolvedValueOnce([option]).mockResolvedValueOnce([{ ...option, selected: false }]);
  api.validateCourseResources.mockResolvedValue({ allowed: true, validationId: "validation" });
  api.saveCourseResources.mockResolvedValue({ savedCount: 0 });
  render(<CourseResourceEditor courseId="run" />);
  const check = await screen.findByRole("checkbox", { name: /Workbook/ });
  expect(check.checked).toBe(true);
  fireEvent.click(check);
  expect(screen.getByText("Saving will remove all resources from this draft.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check selected licences" }));
  const save = screen.getByRole("button", { name: "Confirm resource selection" });
  await waitFor(() => expect(save.disabled).toBe(false));
  fireEvent.click(save);
  expect(await screen.findByText("The course resource selection was saved by the service.")).toBeTruthy();
  await waitFor(() => expect(screen.getByRole("checkbox", { name: /Workbook/ }).disabled).toBe(true));
  expect(api.saveCourseResources).toHaveBeenCalledWith("run", [], "validation", ["v1"]);
});
