import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { setLanguage } from "../../src/i18n/LanguageContext";

const mocks = vi.hoisted(() => ({ resend: vi.fn() }));

// The page only needs these two from the platform context; stub them so the
// test is about the cooldown timer, not the registration flow.
vi.mock("../../src/context/PlatformContext", () => ({
  usePlatform: () => ({
    resendRegistrationEmail: mocks.resend,
    verifyRegistrationEmail: vi.fn(),
  }),
}));

import { VerifyEmailPage } from "../../src/pages/VerifyEmailPage";

beforeEach(() => {
  setLanguage("en");
  mocks.resend.mockReset();
  vi.useFakeTimers({ now: new Date("2026-10-08T00:00:00.000Z") });
});
afterEach(() => {
  act(() => setLanguage("en"));
  vi.useRealTimers();
});

test("resend feedback translates immediately while preserving the code and cooldown", async () => {
  mocks.resend.mockResolvedValue({ resendAvailableAt: new Date(Date.now() + 60_000).toISOString() });
  mountWith({ email: "learner@example.com" });
  const code = screen.getByLabelText("Verification code");
  fireEvent.change(code, { target: { value: "12345678" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Resend email code" })));
  act(() => setLanguage("zh-CN"));
  expect(screen.getByRole("status").textContent).toBe("如果此邮箱有待完成的 CoLearnX 注册，新的验证邮件将很快送达。");
  expect(screen.getByLabelText("验证码")).toBe(code);
  expect(code.value).toBe("12345678");
  act(() => vi.advanceTimersByTime(10_000));
  expect(screen.getByRole("button", { name: /50/ }).disabled).toBe(true);
  act(() => setLanguage("en"));
  expect(screen.getByRole("status").textContent).toContain("If this address has a pending CoLearnX registration");
  expect(screen.getByRole("button", { name: /Resend available in 50s/ }).disabled).toBe(true);
  expect(mocks.resend).toHaveBeenCalledTimes(1);
});

function mountWith(state) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/verify-email", state }]}>
      <VerifyEmailPage />
    </MemoryRouter>,
  );
}

const resendButton = () => screen.getByRole("button", { name: /Resend/ });

test("the resend cooldown counts all the way down to zero and re-enables the button", () => {
  const resendAvailableAt = new Date(Date.now() + 60_000).toISOString();
  mountWith({ email: "learner@example.com", resendAvailableAt });

  expect(resendButton().textContent).toContain("Resend available in 60s");
  expect(resendButton().disabled).toBe(true);

  act(() => { vi.advanceTimersByTime(10_000); });
  expect(resendButton().textContent).toContain("Resend available in 50s");

  // Regression guard for the stall: the whole remaining window must elapse and
  // the button must become available, not freeze partway through.
  act(() => { vi.advanceTimersByTime(50_000); });
  expect(resendButton().textContent).toContain("Resend email code");
  expect(resendButton().disabled).toBe(false);
});
