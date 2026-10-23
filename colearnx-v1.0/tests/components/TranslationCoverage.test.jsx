import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { setLanguage } from "../../src/i18n/LanguageContext";
import { CartPage, CheckoutSuccessPage, OrderHistoryPage } from "../../src/pages/LearningPlatformPages";
import { PublishedPage, RoleApplicationPage } from "../../src/pages/CreatorPlatformPages";
import AdminInboxPage from "../../src/pages/AdminInboxPage";
import { inboxMessages } from "../../src/utils/adminInbox";

const mocks = vi.hoisted(() => ({ platform: {}, inbox: {} }));
vi.mock("../../src/context/PlatformContext", () => ({ usePlatform: () => mocks.platform }));
vi.mock("../../src/context/AdminInboxContext", () => ({ useAdminInbox: () => mocks.inbox }));
const mount = child => render(<MemoryRouter>{child}</MemoryRouter>);
const chinese = () => act(() => setLanguage("zh-CN"));
beforeEach(() => {
  setLanguage("en");
  mocks.platform = { applications: {}, approvedRoles: [], trainerCertifications: [], role: "Creator", publishedItems: [],
    courses: [{ id: "course", title: "Home", trainer: "Trainer", price: 100, deliveryModes: ["local"], refundPolicyPreview: { summary: "Original purchase terms" } }],
    contents: [], cart: [{ kind: "course", id: "course" }], balance: 1000, orders: [],
    notify: vi.fn(), checkout: vi.fn(), refreshOrders: vi.fn(), refreshMyListings: vi.fn(),
  };
});
afterEach(() => act(() => setLanguage("en")));

test("role cards translate status, descriptions and actions while preserving application input", () => {
  mount(<RoleApplicationPage />);
  fireEvent.click(screen.getByRole("button", { name: "Apply for Trainer" }));
  const input = screen.getByLabelText("Subject category *");
  fireEvent.change(input, { target: { value: "Design" } });
  chinese();
  expect(screen.getAllByText("未申请")).toHaveLength(2);
  expect(screen.getByRole("heading", { name: "讲师", exact: true })).not.toBeNull();
  expect(screen.getByText("申请及讲师资质获批后，即可创建课程。")).not.toBeNull();
  expect(screen.getByRole("button", { name: "申请成为创作者" })).not.toBeNull();
  expect(screen.getByLabelText("专业类别 *")).toBe(input);
  expect(input.value).toBe("Design");
});

test("empty listing pages translate headings and explanations", () => {
  mount(<PublishedPage />); chinese();
  expect(screen.getByRole("heading", { name: "暂无内容记录" })).not.toBeNull();
  expect(screen.getByText("您在创作者工作区创建的内容将显示在这里。")).not.toBeNull();
});

test("cart delivery notices and confirmation translate without changing selections or consent", () => {
  mount(<CartPage />);
  fireEvent.click(screen.getByRole("button", { name: "Review final order" }));
  const consent = screen.getByRole("checkbox", { name: /I have reviewed/ });
  fireEvent.click(consent);
  chinese();
  expect(screen.queryByText("Instructor-led course · Offline arrangement")).toBeNull();
  expect(screen.getAllByText(/讲师授课.*线下安排/).length).toBeGreaterThan(0);
  expect(screen.queryAllByText(/Instructor-led course — offline arrangement/)).toHaveLength(0);
  expect(screen.getByRole("checkbox", { name: /我已查看/ })).toBe(consent);
  expect(consent.checked).toBe(true);
  expect(screen.getByRole("button", { name: "支付 100 积分" }).disabled).toBe(false);
  expect(screen.getAllByText("Home").length).toBeGreaterThan(0);
  expect(mocks.platform.checkout).not.toHaveBeenCalled();
});

test("order summaries translate counts while keeping purchased titles", () => {
  mocks.platform.orders = [{ id: "receipt", status: "Paid", total: 20, items: [{ id: "a", title: "Home", price: 10 }, { id: "b", title: "Design", price: 10 }] }];
  mount(<OrderHistoryPage />); chinese();
  expect(screen.getByText("Home + 其他 1 项")).not.toBeNull();
  expect(screen.getByText("Design")).not.toBeNull();
});

test("receipts translate system refund policies and fulfilment states while preserving purchase records", () => {
  mocks.platform.lastOrder = { id: "order", status: "Paid", total: 100, items: [{ id: "item", productId: "course", kind: "course", title: "Home", seller: "Trainer", price: 100, delivery: "Course files", fulfilmentStatus: "fulfilled", refundPolicy: "Recorded video or file refunds require viewing at or below 10% and no protected file download.", refundRecords: [{ reference: "RF-001", status: "pending" }] }] };
  mount(<CheckoutSuccessPage />); chinese();
  expect(screen.getByText("录播视频或文件退款要求观看比例不超过 10%，且未下载受保护文件。")).not.toBeNull();
  expect(screen.getByText("已交付")).not.toBeNull();
  expect(screen.getByText("RF-001: 待审核")).not.toBeNull();
  expect(screen.getByText("Home")).not.toBeNull();
  expect(screen.getByText("Trainer")).not.toBeNull();
  act(() => setLanguage("en"));
  expect(screen.getByText("RF-001: pending")).not.toBeNull();
});

test("inbox labels translate while selection, sender and review link stay unchanged", () => {
  mocks.inbox = { messages: inboxMessages({ role: [{ id: "request", requestedRole: "trainer", status: "pending", applicant: { displayName: "Home" }, supportingText: "Original application" }] }), unreadCount: 0, errors: ["Refund requests"], refresh: vi.fn(), dismissArrival: vi.fn(), markRead: vi.fn(), markAllRead: vi.fn() };
  mount(<AdminInboxPage />);
  fireEvent.click(screen.getByRole("button", { name: /trainer application/ }));
  chinese();
  expect(screen.getByRole("heading", { name: "讲师申请" })).not.toBeNull();
  expect(screen.queryByText(/Refund requests/)).toBeNull();
  expect(screen.getByText("Original application")).not.toBeNull();
  expect(screen.getByRole("link", { name: /打开申请/ }).getAttribute("href")).toBe("/admin/applications?application=request");
  expect(screen.getAllByText("Home")).toHaveLength(2);
  expect(mocks.inbox.refresh).toHaveBeenCalledTimes(1);
});
