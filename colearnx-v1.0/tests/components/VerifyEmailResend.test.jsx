import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// The page only needs these two from the platform context; stub them so the
// test is about the cooldown timer, not the registration flow.
vi.mock("../../src/context/PlatformContext", () => ({
  usePlatform: () => ({
    resendRegistrationEmail: vi.fn(),
    verifyRegistrationEmail: vi.fn(),
  }),
}));

import { VerifyEmailPage } from "../../src/pages/VerifyEmailPage";

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-08T00:00:00.000Z") });
});
afterEach(() => {
  vi.useRealTimers();
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
