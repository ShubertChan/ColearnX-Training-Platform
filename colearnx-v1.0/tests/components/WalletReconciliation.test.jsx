import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, expect, test, vi } from "vitest";
import { setLanguage } from "../../src/i18n/LanguageContext";
import LanguageSwitcher from "../../src/components/LanguageSwitcher";

const mocks = vi.hoisted(() => ({ status: vi.fn(), refresh: vi.fn(), notify: vi.fn() }));
vi.mock("../../src/config/features", () => ({ paymentsApiEnabled: true }));
vi.mock("../../src/api/payments", () => ({ getTopUpStatus: (...args) => mocks.status(...args), createTopUpCheckoutSession: vi.fn() }));
vi.mock("../../src/context/PlatformContext", () => ({ usePlatform: () => ({ balance: 1000, walletBalances: { available: 1000, frozen: 0, expired: 0, blocked: 0 }, transactions: [], refreshWallet: mocks.refresh, notify: mocks.notify }) }));
import { WalletPage } from "../../src/pages/WalletAdminPages";
function Location() { const location = useLocation(); return <output data-testid="location">{location.pathname}{location.search}</output>; }
const mount = () => render(<MemoryRouter initialEntries={["/wallet?paymentTransactionId=payment"]}><LanguageSwitcher /><WalletPage /><Location /></MemoryRouter>);
beforeEach(() => { setLanguage("en"); mocks.status.mockReset(); mocks.refresh.mockReset(); mocks.notify.mockReset(); });

test("paid top-up refreshes once, clears the return URL and notifies once", async () => {
  mocks.status.mockResolvedValue({ status: "paid", points: 500 }); mocks.refresh.mockResolvedValue({ available: 1500 });
  mount();
  expect(await screen.findByText("Payment confirmed. Your wallet has been refreshed.")).not.toBeNull();
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/wallet"));
  expect(mocks.status).toHaveBeenCalledTimes(1); expect(mocks.refresh).toHaveBeenCalledTimes(1); expect(mocks.notify).toHaveBeenCalledTimes(1);
});

test("failed secondary refresh never implies payment failed; retry does not check or create a payment", async () => {
  mocks.status.mockResolvedValue({ status: "paid", points: 500 });
  mocks.refresh.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ available: 1500 });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Retry wallet refresh" }));
  expect(await screen.findByText("Payment confirmed. Your wallet has been refreshed.")).not.toBeNull();
  expect(mocks.refresh).toHaveBeenCalledTimes(2); expect(mocks.status).toHaveBeenCalledTimes(1); expect(mocks.notify).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("location").textContent).toBe("/wallet");
});

for (const status of ["cancelled", "failed", "expired"]) test(`${status} payments stop verification without crediting points`, async () => {
  mocks.status.mockResolvedValue({ status }); mount();
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/wallet"));
  expect(mocks.status).toHaveBeenCalledTimes(1); expect(mocks.refresh).not.toHaveBeenCalled(); expect(mocks.notify).not.toHaveBeenCalled();
});

test("language switch during an in-flight payment check does not restart reconciliation", async () => {
  let resolve; mocks.status.mockReturnValue(new Promise(done => { resolve = done; })); mocks.refresh.mockResolvedValue({ available: 1500 });
  mount();
  fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "zh-CN" } });
  await act(async () => resolve({ status: "paid", points: 500 }));
  expect(await screen.findByText("付款已确认，钱包已刷新。")).not.toBeNull();
  expect(mocks.status).toHaveBeenCalledTimes(1); expect(mocks.refresh).toHaveBeenCalledTimes(1);
  act(() => setLanguage("en"));
});
