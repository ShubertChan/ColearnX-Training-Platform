import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ summary: vi.fn(), events: vi.fn() }));
vi.mock("../../src/api/security", () => ({
  getSecuritySummary: (...args) => mocks.summary(...args),
  getSecurityEvents: (...args) => mocks.events(...args),
}));

import AdminSecurityDashboardPage from "../../src/pages/AdminSecurityDashboardPage";

const summary = {
  range: { from: "2026-09-08", to: "2026-10-07" },
  total: 42,
  severe: 5,
  severityTotals: { 0: 20, 1: 10, 2: 7, 3: 4, 4: 1 },
  highlights: {
    failedLogins: 18,
    accountsLocked: 3,
    rateLimited: 6,
    breachUnavailable: 2,
    mfaDisabled: 0,
    refreshReused: 1,
    distinctSources: 12,
    accountsTargeted: 4,
  },
  byType: [
    { type: "auth.login_failed", count: 18, severity: 1 },
    { type: "access.rate_limited", count: 6, severity: 1 },
  ],
  daily: [
    { date: "2026-10-05", total: 10, severe: 2 },
    { date: "2026-10-06", total: 4, severe: 1 },
    { date: "2026-10-07", total: 0, severe: 0 },
  ],
};

const eventsPage = {
  events: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      occurredAt: "2026-10-07T04:00:00.000Z",
      type: "auth.login_failed",
      severity: 1,
      decision: "allow",
      actorId: "11111111-2222-4333-8444-555555555555",
      targetId: null,
      requestId: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
      riskScore: 0,
      ruleHits: [],
      source: "a1b2c3d4e5f6",
      context: { route: "/auth/login" },
    },
  ],
  hasNext: false,
  nextCursor: null,
};

beforeEach(() => {
  mocks.summary.mockReset();
  mocks.events.mockReset();
  mocks.summary.mockResolvedValue(summary);
  mocks.events.mockResolvedValue(eventsPage);
});

const mount = () => render(<MemoryRouter><AdminSecurityDashboardPage /></MemoryRouter>);

test("renders KPI tiles, the trend and a non-identifying event row", async () => {
  mount();

  // KPI tiles read from the summary highlights.
  expect(await screen.findByText("Failed sign-ins")).toBeTruthy();
  expect(screen.getByText("Account lockouts")).toBeTruthy();
  // 18 appears both as the failed-sign-ins tile and the by-type count.
  expect(screen.getAllByText("18").length).toBeGreaterThan(0);

  // The event stream renders a readable type and the salted source prefix,
  // and never a raw IP address.
  expect(await screen.findByText("Auth · Login failed", { selector: ".sec-event-type" })).toBeTruthy();
  expect(screen.getByText("a1b2c3d4e5f6")).toBeTruthy();
  expect(screen.queryByText(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/)).toBeNull();

  // The trend exposes an accessible description rather than being colour-only.
  expect(screen.getByRole("img", { name: /Daily security events/ })).toBeTruthy();
});

test("the severity filter reloads the event stream with the chosen minimum", async () => {
  mount();
  await screen.findByText("Auth · Login failed", { selector: ".sec-event-type" });

  mocks.events.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "High+" }));

  await waitFor(() => expect(mocks.events).toHaveBeenCalled());
  const call = mocks.events.mock.calls.at(-1)[0];
  expect(call.minSeverity).toBe(3);
});

test("a dismissed step-up prompt shows a calm re-entry instead of an error", async () => {
  mocks.summary.mockRejectedValue(Object.assign(new Error("cancelled"), { code: "STEP_UP_CANCELLED" }));
  mocks.events.mockRejectedValue(Object.assign(new Error("cancelled"), { code: "STEP_UP_CANCELLED" }));
  mount();

  expect(await screen.findByText(/Confirm your identity to view security telemetry/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});
