import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, expect, test, vi } from "vitest";
import { setLanguage } from "../../src/i18n/LanguageContext";

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), load: vi.fn(), stripe: vi.fn(), payment: null, express: null, state: "success" }));
vi.mock("../../src/api/payments", () => ({ getTopUpCheckoutSession: mocks.load }));
vi.mock("../../src/context/PlatformContext", () => ({ usePlatform: () => ({ profile: { id: "owner" } }) }));
vi.mock("@stripe/stripe-js/pure", () => ({ loadStripe: mocks.stripe }));
vi.mock("@stripe/react-stripe-js/checkout", () => ({
  CheckoutElementsProvider: ({ children }) => children,
  useCheckoutElements: () => ({ type: mocks.state, checkout: { confirm: mocks.confirm } }),
  PaymentElement: props => { mocks.payment = props; return <div data-testid="payment-element" />; },
  ExpressCheckoutElement: props => { mocks.express = props; return <div data-testid="express-element" />; },
}));
import TopUpCheckoutPage, { TopUpPaymentForm } from "../../src/pages/TopUpCheckoutPage";
const session = { email: "learner@example.test", currency: "sgd", amountMinor: 500, points: 500, clientSecret: "cs_test_secret", publishableKey: "pk_test_fixture", expiresAt: Math.floor(Date.now() / 1000) + 3600, status: "open" };
function Location() { const location = useLocation(); return <output data-testid="location">{location.pathname + location.search}</output>; }
function mount(loader = false) {
  return render(<MemoryRouter initialEntries={["/wallet/checkout/payment"]}><Location /><Routes><Route path="/wallet/checkout/:paymentTransactionId" element={loader ? <TopUpCheckoutPage /> : <TopUpPaymentForm session={session} paymentTransactionId="payment" onRetry={vi.fn()} />} /><Route path="/wallet" element={<p>Wallet</p>} /></Routes></MemoryRouter>);
}
function ready(available = true) {
  act(() => { mocks.payment.onReady(); mocks.payment.onChange({ complete: true }); mocks.express.onReady({ availablePaymentMethods: available ? { applePay: true, link: true } : undefined }); });
}
beforeEach(() => { vi.clearAllMocks(); setLanguage("en"); mocks.state = "success"; mocks.load.mockResolvedValue(session); mocks.stripe.mockResolvedValue({}); mocks.confirm.mockResolvedValue({ type: "success" }); });

test("contact and standard payment methods precede express wallets in Chinese and English", () => {
  mount(); ready();
  const contact = screen.getByRole("heading", { name: "Contact information" });
  const payment = screen.getByTestId("payment-element");
  const express = screen.getByTestId("express-element");
  expect(contact.compareDocumentPosition(payment) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(payment.compareDocumentPosition(express) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  act(() => setLanguage("zh-CN"));
  expect(screen.getByRole("heading", { name: "支付方式" })).not.toBeNull();
  expect(screen.getByText("或使用快捷支付")).not.toBeNull();
});

test("pay requires completed fields and a decline can be retried without recreating the session", async () => {
  mocks.confirm.mockResolvedValueOnce({ type: "error", error: { message: "Your card was declined." } });
  mount();
  expect(screen.getByRole("button", { name: /Pay/ }).disabled).toBe(true);
  ready();
  fireEvent.click(screen.getByRole("button", { name: /Pay/ }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Your card was declined.");
  fireEvent.click(screen.getByRole("button", { name: /Pay/ }));
  await waitFor(() => expect(screen.getByTestId("location").textContent).toContain("/wallet?topUp=processing&paymentTransactionId=payment"));
  expect(mocks.confirm).toHaveBeenCalledTimes(2);
  expect(mocks.load).not.toHaveBeenCalled();
});

test("wallet confirmation works without card fields and rejects simultaneous submissions", async () => {
  let resolve;
  mocks.confirm.mockReturnValue(new Promise(done => { resolve = done; }));
  mount();
  const event = { paymentFailed: vi.fn() };
  act(() => { mocks.express.onConfirm(event); mocks.express.onConfirm(event); });
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  expect(mocks.confirm).toHaveBeenCalledWith({ redirect: "if_required", expressCheckoutConfirmEvent: event });
  expect(event.paymentFailed).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ type: "success" }));
});

test("unavailable wallets leave no empty express section", () => {
  mount(); ready(false);
  expect(screen.queryByRole("region", { name: "Express payment" })).toBeNull();
  expect(screen.getByRole("button", { name: /Pay/ }).disabled).toBe(false);
});

test("network confirmation failure restores payment controls", async () => {
  mocks.confirm.mockRejectedValue(new Error("offline"));
  mount(); ready(); fireEvent.click(screen.getByRole("button", { name: /Pay/ }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "We could not confirm this payment. Please try again.");
  expect(screen.getByRole("button", { name: /Pay/ }).disabled).toBe(false);
});

test("refresh loads the existing payment using its ID without storing its secret", async () => {
  mount(true);
  await screen.findByTestId("payment-element");
  expect(mocks.load).toHaveBeenCalledWith("payment");
  expect(mocks.stripe).toHaveBeenCalledWith("pk_test_fixture", { locale: "en" });
  expect(JSON.stringify(localStorage)).not.toContain("cs_test_secret");
  expect(JSON.stringify(sessionStorage)).not.toContain("cs_test_secret");
});

test("switching languages retains payment fields and an in-flight confirmation", async () => {
  let resolve;
  mocks.confirm.mockReturnValue(new Promise(done => { resolve = done; }));
  mount(true);
  const element = await screen.findByTestId("payment-element");
  ready();
  fireEvent.click(screen.getByRole("button", { name: /Pay/ }));
  act(() => setLanguage("zh-CN"));
  await screen.findByRole("heading", { name: "支付方式" });
  expect(screen.getByTestId("payment-element")).toBe(element);
  expect(screen.getByRole("button", { name: "正在处理…" }).disabled).toBe(true);
  expect(mocks.load).toHaveBeenCalledTimes(1);
  expect(mocks.stripe).toHaveBeenCalledTimes(1);
  act(() => setLanguage("en"));
  expect(screen.getByRole("button", { name: "Processing…" }).disabled).toBe(true);
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ type: "error", error: { message: "We could not confirm this payment. Please try again." } }));
  expect(screen.getByRole("button", { name: /Pay/ }).disabled).toBe(false);
});

test("completed sessions return to server reconciliation without loading Stripe", async () => {
  mocks.load.mockResolvedValue({ status: "complete" }); mount(true);
  await waitFor(() => expect(screen.getByTestId("location").textContent).toContain("topUp=processing"));
  expect(mocks.stripe).not.toHaveBeenCalled();
});

test("session load errors offer a retry that requests the same payment", async () => {
  mocks.load.mockRejectedValueOnce(new Error("Unable to load secure payment. Please try again."));
  mount(true); fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await screen.findByTestId("payment-element");
  expect(mocks.load.mock.calls).toEqual([["payment"], ["payment"]]);
});
