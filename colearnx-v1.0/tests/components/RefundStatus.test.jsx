import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ orders: [], delivery: vi.fn() }));
vi.mock("../../src/context/PlatformContext", () => ({ usePlatform: () => ({ orders: mocks.orders, refreshOrders: vi.fn() }) }));
vi.mock("../../src/api/courseDelivery", () => ({ getCourseDelivery: mocks.delivery, requestCourseDownloadUrl: vi.fn() }));
import { CheckoutSuccessPage, OrderHistoryPage, PurchasesPage, RefundPage } from "../../src/pages/LearningPlatformPages";
import { setLanguage } from "../../src/i18n/LanguageContext";

function order(status, fulfilmentStatus = "fulfilled") {
  return { id: "order", status: "Paid", total: 100, items: [{ id: "item", kind: "course", productId: "course", title: "Original course title", price: 100, fulfilmentStatus, deliveryModes: [], refundPolicy: "Purchase-time policy", refundRecords: status ? [{ status, decisionReason: status === "rejected" ? "Outside the original policy" : undefined }] : [] }] };
}
function mount(path) {
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/orders" element={<OrderHistoryPage />} />
    <Route path="/checkout-success/:orderId" element={<CheckoutSuccessPage />} />
    <Route path="/purchases" element={<PurchasesPage />} />
    <Route path="/refund/:id" element={<RefundPage />} />
  </Routes></MemoryRouter>);
}
beforeEach(() => { setLanguage("en"); mocks.orders = [order("pending")]; mocks.delivery.mockReset().mockResolvedValue({}); });

for (const path of ["/orders", "/checkout-success/order", "/purchases", "/refund/course?orderItem=item"]) {
  test(`pending refund status is visible and cannot be duplicated on ${path}`, () => {
    mount(path);
    expect(screen.getByRole("status").textContent).toContain("Refund under review");
    expect(screen.getByRole("status").textContent).toContain("No points have been refunded yet");
    expect(screen.queryByRole("link", { name: "Request refund" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit for review" })).toBeNull();
  });
}

test("refunded purchases keep a readable status page without requesting revoked delivery", () => {
  mocks.orders = [order("approved", "refunded")];
  mount("/refund/course?orderItem=item");
  expect(screen.getByRole("status").textContent).toContain("The points have been returned to your wallet");
  expect(mocks.delivery).not.toHaveBeenCalled();
  act(() => setLanguage("zh-CN"));
  expect(screen.getByRole("status").textContent).toContain("已退款");
  expect(screen.getByRole("heading", { name: "Original course title" })).toBeTruthy();
});

test("rejection shows its reason and allows another request", () => {
  mocks.orders = [order("rejected")];
  mount("/refund/course?orderItem=item");
  expect(screen.getByRole("status").textContent).toContain("Outside the original policy");
  expect(screen.getByRole("button", { name: "Submit for review" })).toBeTruthy();
});

test("a purchase without a request shows its initial state on the application page", () => {
  mocks.orders = [order(null)];
  mount("/refund/course?orderItem=item");
  expect(screen.getByRole("status").textContent).toContain("No refund requested");
  expect(screen.getByRole("button", { name: "Submit for review" })).toBeTruthy();
});
