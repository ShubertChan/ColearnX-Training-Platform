import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, test, vi } from "vitest";
import { setLanguage } from "../../src/i18n/LanguageContext";

const mocks = vi.hoisted(() => ({ load: vi.fn(), stripe: vi.fn() }));
vi.mock("../../src/api/payments", () => ({ getTopUpCheckoutSession: mocks.load }));
vi.mock("../../src/context/PlatformContext", () => ({ usePlatform: () => ({ profile: { id: "owner" } }) }));
vi.mock("@stripe/stripe-js/pure", () => ({ loadStripe: mocks.stripe }));
// Keep the real React Stripe provider and Element lifecycle. Mock only the
// network-facing SDK so initialization and layout-effect failures are exercised.
import TopUpCheckoutPage, { PAYMENT_LOAD_TIMEOUT_MS } from "../../src/pages/TopUpCheckoutPage";

const session = { email: "learner@example.test", currency: "sgd", amountMinor: 500, points: 5, clientSecret: "cs_test_secret", publishableKey: "pk_test_fixture", expiresAt: Math.floor(Date.now() / 1000) + 3600, status: "open" };
const unavailable = "Unable to load secure payment. Please try again.";
let sdk, stripe, payment, express, confirm;
function element() {
  const handlers = new Map();
  return {
    mount: vi.fn(), destroy: vi.fn(), update: vi.fn(),
    on: vi.fn((name, handler) => handlers.set(name, handler)),
    off: vi.fn(name => handlers.delete(name)),
    emit: (name, event) => act(() => handlers.get(name)?.(event)),
  };
}
async function mount() {
  render(<StrictMode><MemoryRouter initialEntries={["/wallet/checkout/payment"]}><p>Application shell</p><Routes><Route path="/wallet/checkout/:paymentTransactionId" element={<TopUpCheckoutPage />} /></Routes></MemoryRouter></StrictMode>);
  await act(async () => {});
}
beforeEach(() => {
  vi.clearAllMocks();
  setLanguage("en");
  payment = element(); express = element(); confirm = vi.fn().mockResolvedValue({ type: "error", error: { message: "Your card was declined." } });
  sdk = {
    on: vi.fn(), changeAppearance: vi.fn(), loadFonts: vi.fn(),
    loadActions: vi.fn().mockResolvedValue({ type: "success", actions: { getSession: () => ({}), confirm } }),
    createPaymentElement: vi.fn(() => payment), createExpressCheckoutElement: vi.fn(() => express),
  };
  stripe = { elements: vi.fn(), createToken: vi.fn(), createPaymentMethod: vi.fn(), confirmCardPayment: vi.fn(), initCheckoutElementsSdk: vi.fn(() => sdk) };
  mocks.load.mockResolvedValue(session);
  mocks.stripe.mockResolvedValue(stripe);
});

test("real provider receives the current Stripe layout contract and enables payment", async () => {
  await mount();
  expect(sdk.createPaymentElement).toHaveBeenCalledWith(expect.objectContaining({
    layout: { type: "accordion", defaultCollapsed: false, radios: "always", spacedAccordionItems: false },
  }));
  payment.emit("ready"); payment.emit("change", { complete: true });
  fireEvent.click(screen.getByRole("button", { name: /^Pay / }));
  await act(async () => {});
  expect(confirm).toHaveBeenCalledWith({ redirect: "if_required" });
  expect(screen.getByRole("alert").textContent).toBe("Your card was declined.");
});

test("a synchronous payment Element creation error preserves the shell and retry recreates checkout", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  sdk.createPaymentElement.mockImplementation(() => { throw new Error("IntegrationError: invalid layout"); });
  await mount();
  expect(screen.getByRole("alert").textContent).toBe(unavailable);
  expect(screen.getByText("Application shell")).not.toBeNull();
  expect(screen.getByRole("link", { name: "Back to wallet" })).not.toBeNull();
  sdk.createPaymentElement.mockImplementation(() => payment);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await act(async () => {});
  expect(screen.queryByRole("alert")).toBeNull();
  expect(payment.mount).toHaveBeenCalled();
  expect(mocks.load.mock.calls.every(([id]) => id === "payment")).toBe(true);
});

test("optional express wallet creation failures leave card payment usable", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  sdk.createExpressCheckoutElement.mockImplementation(() => { throw new Error("wallet unavailable"); });
  await mount();
  payment.emit("ready"); payment.emit("change", { complete: true });
  expect(screen.getByRole("button", { name: /^Pay / }).disabled).toBe(false);
  expect(screen.queryByRole("region", { name: "Express payment" })).toBeNull();
});

test.each(["session", "script", "actions", "element"])("stalled %s loading times out and can be retried", async stage => {
  vi.useFakeTimers();
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  if (stage === "session") mocks.load.mockReturnValue(pending);
  if (stage === "script") mocks.stripe.mockReturnValue(pending);
  if (stage === "actions") sdk.loadActions.mockReturnValue(pending);
  await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(PAYMENT_LOAD_TIMEOUT_MS); });
  expect(screen.getByRole("alert").textContent).toBe(unavailable);
  expect(screen.getByText("Application shell")).not.toBeNull();
  mocks.load.mockResolvedValue(session); mocks.stripe.mockResolvedValue(stripe);
  sdk.loadActions.mockResolvedValue({ type: "success", actions: { getSession: () => ({}), confirm } });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await act(async () => {});
  payment.emit("ready"); payment.emit("change", { complete: true });
  expect(screen.getByRole("button", { name: /^Pay / }).disabled).toBe(false);
  // A previous request finishing after recovery must not replace entered fields.
  const pay = screen.getByRole("button", { name: /^Pay / });
  await act(async () => resolve(stage === "session" ? session : stage === "script" ? stripe : { type: "error", error: new Error("late error") }));
  expect(screen.getByRole("button", { name: /^Pay / })).toBe(pay);
  expect(screen.queryByRole("alert")).toBeNull();
});

test.each(["throw", "reject", "error"])("SDK initialization failure (%s) offers retry", async mode => {
  if (mode === "throw") stripe.initCheckoutElementsSdk.mockImplementation(() => { throw new Error("init failure"); });
  if (mode === "reject") sdk.loadActions.mockRejectedValue(new Error("network failure"));
  if (mode === "error") sdk.loadActions.mockResolvedValue({ type: "error", error: new Error("session failure") });
  await mount();
  expect(screen.getByRole("alert").textContent).toBe(unavailable);
  expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
});

test("PaymentElement loaderror removes failed controls and offers recovery", async () => {
  await mount();
  payment.emit("loaderror", { error: new Error("iframe blocked") });
  expect(screen.getByRole("alert").textContent).toBe(unavailable);
  expect(screen.queryByRole("button", { name: /^Pay / })).toBeNull();
  expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
});

test("ready checkout keeps entered fields and an in-flight confirmation after the load deadline", async () => {
  vi.useFakeTimers();
  confirm.mockReturnValue(new Promise(() => {}));
  await mount();
  payment.emit("ready"); payment.emit("change", { complete: true });
  fireEvent.click(screen.getByRole("button", { name: /^Pay / }));
  await act(async () => { await vi.advanceTimersByTimeAsync(PAYMENT_LOAD_TIMEOUT_MS * 2); });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Processing…" }).disabled).toBe(true);
  expect(confirm).toHaveBeenCalledTimes(1);
});

test("express confirmation is not interrupted while card fields are still loading", async () => {
  vi.useFakeTimers();
  confirm.mockReturnValue(new Promise(() => {}));
  await mount();
  express.emit("confirm", { paymentFailed: vi.fn() });
  await act(async () => { await vi.advanceTimersByTimeAsync(PAYMENT_LOAD_TIMEOUT_MS * 2); });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Processing…" }).disabled).toBe(true);
  expect(confirm).toHaveBeenCalledTimes(1);
});
