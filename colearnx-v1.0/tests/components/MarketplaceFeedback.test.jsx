import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ orders: vi.fn(), refund: vi.fn(), decision: vi.fn(), fulfilment: "fulfilled" }));
vi.mock("../../src/api/client", async (original) => ({ ...await original(), hasAccessToken: () => true, hasCsrfToken: () => true }));
vi.mock("../../src/api/auth", async (original) => ({ ...await original(), getCurrentUser: async () => ({ id: "feedback-member", email: "member@example.test", roles: ["member"], profile: { displayName: "Member" } }) }));
vi.mock("../../src/api/catalog", async (original) => ({ ...await original(),
  listCourses: async () => [{ id: "course", title: "Design course", status: "published", pricePoints: 100, refundPolicyPreview: { summary: "Refunds subject to review." } }],
  listContent: async () => [{ id: "resource", title: "Design template", status: "published", pricePoints: 50, refundPolicyPreview: { summary: "Refunds subject to review." } }],
}));
vi.mock("../../src/api/wallet", async (original) => ({ ...await original(), getWallet: async () => ({ availablePoints: 1000 }), getWalletTransactions: async () => [] }));
vi.mock("../../src/api/governance", async (original) => ({ ...await original(), getMyRoleApplications: async () => [], getAdminRoleApplications: async () => [], getAdminTrainerCertifications: async () => [] }));
vi.mock("../../src/api/commerce", async (original) => ({ ...await original(), listOrders: (...args) => mocks.orders(...args), getOrder: async () => ({ id: "order", status: "paid", items: [{ id: "order-item", productId: "purchased-course", kind: "course", title: "Purchased course", fulfilmentStatus: mocks.fulfilment, pricePoints: 100, refundPolicySnapshot: { summary: "Refunds subject to review." } }] }) }));
vi.mock("../../src/api/refunds", async (original) => ({ ...await original(), createRefundRequest: (...args) => mocks.refund(...args), decideRefundRequest: (...args) => mocks.decision(...args), getAdminRefundRequests: async () => [] }));
vi.mock("../../src/api/courseDelivery", async (original) => ({ ...await original(), getCourseDelivery: async () => ({ refundEligibility: { eligible: true } }) }));

import { PlatformProvider, usePlatform } from "../../src/context/PlatformContext";
import { CourseDetailPage, ContentDetailPage } from "../../src/pages/MarketplacePlatformPages";
import { RefundPage } from "../../src/pages/LearningPlatformPages";

function DecisionHarness() {
  const { decideRefund, refreshOrders, orders } = usePlatform();
  return <><button onClick={() => void decideRefund("refund", "Approved", "Eligible refund").catch(() => {})}>Approve refund</button><button onClick={() => void refreshOrders()}>Refresh orders</button><span>{orders[0]?.items[0]?.fulfilmentStatus}</span></>;
}
function mount(path) {
  return render(<MemoryRouter initialEntries={[path]}><PlatformProvider><Routes>
    <Route path="/courses/:id" element={<CourseDetailPage />} />
    <Route path="/contents/:id" element={<ContentDetailPage />} />
    <Route path="/refund/:id" element={<RefundPage />} />
    <Route path="/orders" element={<h1>Order History</h1>} />
    <Route path="/cart" element={<h1>Shopping Cart</h1>} />
    <Route path="/review" element={<DecisionHarness />} />
  </Routes></PlatformProvider></MemoryRouter>);
}
beforeEach(() => {
  localStorage.clear();
  mocks.fulfilment = "fulfilled";
  mocks.orders.mockReset().mockResolvedValue([]);
  mocks.refund.mockReset().mockResolvedValue({ id: "refund", status: "pending" });
  mocks.decision.mockReset().mockResolvedValue({ id: "refund", status: "approved" });
});

for (const [path, title] of [["/courses/course", "Course added to cart"], ["/contents/resource", "Resource added to cart"]]) {
  test(`${title} opens a dialog and links to the cart`, async () => {
    mount(path);
    const add = await screen.findByRole("button", { name: "Add to cart" });
    fireEvent.click(add);
    const dialog = await screen.findByRole("dialog", { name: title });
    expect(screen.getByRole("button", { name: "Already in cart" }).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("link", { name: "View cart" }));
    expect(screen.getByRole("heading", { name: "Shopping Cart" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
}

test("cart feedback closes on Escape and cannot duplicate the item", async () => {
  mount("/courses/course");
  fireEvent.click(await screen.findByRole("button", { name: "Add to cart" }));
  await screen.findByRole("dialog");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(JSON.parse(localStorage.getItem("colearnx-cart-v3:feedback-member"))).toHaveLength(1);
});

test("refund submission feedback survives navigation and does not claim money was returned", async () => {
  mocks.orders.mockResolvedValue([{ id: "order" }]);
  mount("/refund/purchased-course?orderItem=order-item");
  fireEvent.change(await screen.findByLabelText(/Reason for request/), { target: { value: "Changed my mind" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
  const dialog = await screen.findByRole("dialog", { name: "Refund request submitted" });
  await screen.findByRole("heading", { name: "Order History" });
  expect(within(dialog).getByText(/administrator review/)).toBeTruthy();
  expect(screen.queryByText(/points have been returned/)).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "OK", exact: true }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a failed refund request shows its error without success feedback", async () => {
  mocks.orders.mockResolvedValue([{ id: "order" }]);
  mocks.refund.mockRejectedValue(new Error("Refund unavailable"));
  mount("/refund/purchased-course?orderItem=order-item");
  fireEvent.change(await screen.findByLabelText(/Reason for request/), { target: { value: "Changed my mind" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Refund unavailable");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("approved refund keeps success feedback when the subsequent order refresh fails", async () => {
  mount("/review");
  await waitFor(() => expect(mocks.orders).toHaveBeenCalled());
  mocks.orders.mockRejectedValue(new Error("Refresh unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Approve refund" }));
  const dialog = await screen.findByRole("dialog", { name: "Refund successful" });
  expect(within(dialog).getByText(/points have been returned/)).toBeTruthy();
  expect(mocks.decision).toHaveBeenCalledWith("refund", { decision: "approved", reason: "Eligible refund" });
});

test("a failed refund approval does not open a success dialog", async () => {
  mocks.decision.mockRejectedValue(new Error("Decision unavailable"));
  mount("/review");
  fireEvent.click(screen.getByRole("button", { name: "Approve refund" }));
  await waitFor(() => expect(mocks.decision).toHaveBeenCalled());
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a member sees a newly confirmed refund once, without repeating old refund dialogs", async () => {
  mocks.orders.mockResolvedValue([{ id: "order" }]);
  mount("/review");
  await screen.findByText("fulfilled");
  expect(screen.queryByRole("dialog")).toBeNull();
  mocks.fulfilment = "refunded";
  fireEvent.click(screen.getByRole("button", { name: "Refresh orders" }));
  const dialog = await screen.findByRole("dialog", { name: "Refund successful" });
  expect(within(dialog).getByText(/your wallet/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "OK", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh orders" }));
  await waitFor(() => expect(mocks.orders.mock.calls.length).toBeGreaterThanOrEqual(3));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("an already refunded order does not open a stale success dialog on sign-in", async () => {
  mocks.orders.mockResolvedValue([{ id: "order" }]);
  mocks.fulfilment = "refunded";
  mount("/review");
  await screen.findByText("refunded");
  expect(screen.queryByRole("dialog")).toBeNull();
});
