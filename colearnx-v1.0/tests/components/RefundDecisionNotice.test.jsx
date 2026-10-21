import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, expect, test, vi } from "vitest";
import { setLanguage } from "../../src/i18n/LanguageContext";

const mocks = vi.hoisted(() => ({ get: vi.fn(), read: vi.fn(), wallet: vi.fn(), orders: vi.fn(), account: {} }));
vi.mock("../../src/api/notifications", () => ({ getRefundNotifications: (...args) => mocks.get(...args), acknowledgeRefundNotification: (...args) => mocks.read(...args) }));
vi.mock("../../src/context/PlatformContext", () => ({ usePlatform: () => ({ ...mocks.account, refreshWallet: mocks.wallet, refreshOrders: mocks.orders }) }));
import RefundDecisionNotice from "../../src/components/RefundDecisionNotice";

const approved = { id: "notice-1", status: "approved", itemTitle: "Design course", decisionReason: "Request meets the refund policy.", points: 120, orderId: "order-1" };
const rejected = { ...approved, id: "notice-2", status: "rejected", decisionReason: "The viewing limit was exceeded." };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function Location() { return <output>{useLocation().pathname}</output>; }
const ui = () => <MemoryRouter><RefundDecisionNotice /><Location /></MemoryRouter>;

beforeEach(() => {
  vi.clearAllMocks();
  setLanguage("en");
  mocks.account = { authenticated: true, profile: { id: "member-1" } };
  mocks.get.mockReset().mockImplementation(() => new Promise(() => {}));
  mocks.read.mockReset().mockResolvedValue(undefined);
  mocks.wallet.mockResolvedValue(undefined);
  mocks.orders.mockResolvedValue(undefined);
});

test("offline decisions appear on login, persist across remounts, and are read only after confirmation", async () => {
  let unread = true;
  mocks.get.mockImplementation(() => unread ? Promise.resolve([approved]) : new Promise(() => {}));
  mocks.read.mockImplementation(async () => { unread = false; });
  const first = render(ui());
  await screen.findByRole("dialog", { name: "Refund approved" });
  expect(mocks.get.mock.calls[0][0].wait).toBe(false);
  expect(mocks.read).not.toHaveBeenCalled();
  first.unmount();
  const next = render(ui());
  await screen.findByRole("dialog", { name: "Refund approved" });
  fireEvent.click(screen.getByRole("button", { name: "Got it" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(mocks.read.mock.calls[0][0]).toBe(approved.id);
  next.unmount();
  render(ui());
  await act(async () => {});
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("an online decision wakes the waiting request and appears without navigation", async () => {
  vi.useFakeTimers();
  const live = deferred();
  mocks.get.mockResolvedValueOnce([]).mockReturnValueOnce(live.promise);
  render(ui());
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(mocks.get.mock.calls[1][0].wait).toBe(true);
  await act(async () => live.resolve([rejected]));
  expect(screen.getByRole("dialog", { name: "Refund rejected" })).toBeTruthy();
  expect(screen.getByText(rejected.decisionReason)).toBeTruthy();
  expect(mocks.read).not.toHaveBeenCalled();
});

test("failed acknowledgement retains the result; retry advances to the next unread decision", async () => {
  mocks.get.mockResolvedValueOnce([approved, rejected]).mockResolvedValueOnce([rejected]);
  mocks.read.mockRejectedValueOnce(new Error("Offline"));
  render(ui());
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Got it" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "Refund approved" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Got it" }));
  await screen.findByRole("dialog", { name: "Refund rejected" });
  expect(mocks.read.mock.calls.map(call => call[0])).toEqual([approved.id, approved.id]);
});

test("logout aborts the wait and a late response cannot leak into another account", async () => {
  const late = deferred();
  mocks.get.mockReturnValueOnce(late.promise);
  const view = render(ui());
  const signal = mocks.get.mock.calls[0][0].signal;
  mocks.account = { authenticated: false };
  view.rerender(ui());
  expect(signal.aborted).toBe(true);
  mocks.account = { authenticated: true, profile: { id: "member-2" } };
  view.rerender(ui());
  await act(async () => late.resolve([approved]));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("returning online retries immediately after a failure and supports Chinese confirmation", async () => {
  setLanguage("zh-CN");
  mocks.get.mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce([approved]);
  render(ui());
  await act(async () => {});
  fireEvent(window, new Event("online"));
  await screen.findByRole("dialog", { name: "退款申请已批准" });
  expect(screen.getByText("退款的 120 积分已退回您的钱包。")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "查看订单" }));
  await screen.findByText("/orders");
});

test("closing by Escape acknowledges once while an acknowledgement is in flight", async () => {
  const pending = deferred();
  mocks.get.mockResolvedValueOnce([approved]);
  mocks.read.mockReturnValueOnce(pending.promise);
  render(ui());
  await screen.findByRole("dialog");
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(mocks.read).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
