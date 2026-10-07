import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTrend,
  formatEventType,
  severityLabel,
  severityTone,
  totalFromSeverity,
} from "./securityDashboard.js";

test("severity maps to a label and a design-system tone", () => {
  assert.equal(severityLabel(0), "Info");
  assert.equal(severityLabel(3), "High");
  assert.equal(severityLabel(4), "Critical");
  assert.equal(severityTone(2), "warning");
  assert.equal(severityTone(4), "danger");
  // An unexpected level degrades gracefully rather than throwing in render.
  assert.equal(severityLabel(9), "Level 9");
  assert.equal(severityTone(9), "neutral");
});

test("dotted event types become a readable category and name", () => {
  assert.equal(formatEventType("auth.login_failed"), "Auth · Login failed");
  assert.equal(formatEventType("access.rate_limited"), "Access · Rate limited");
  assert.equal(formatEventType("session.refresh_reused"), "Session · Refresh reused");
  assert.equal(formatEventType(""), "");
});

test("trend bars scale to the busiest day and never exceed the total", () => {
  const { peak, bars } = buildTrend([
    { date: "2026-09-01", total: 10, severe: 2 },
    { date: "2026-09-02", total: 5, severe: 1 },
    { date: "2026-09-03", total: 0, severe: 0 },
  ]);
  assert.equal(peak, 10);
  assert.equal(bars[0].totalPct, 100);
  assert.equal(bars[1].totalPct, 50);
  assert.equal(bars[0].routine, 8);
  // A severe count larger than total (impossible, but defensive) is clamped.
  const clamped = buildTrend([{ date: "2026-09-01", total: 3, severe: 9 }]);
  assert.equal(clamped.bars[0].severe, 3);
  assert.equal(clamped.bars[0].routine, 0);
});

test("an all-zero window produces flat bars rather than dividing by zero", () => {
  const { peak, bars } = buildTrend([{ date: "2026-09-01", total: 0, severe: 0 }]);
  assert.equal(peak, 0);
  assert.equal(bars[0].totalPct, 0);
});

test("severity totals sum to the window total", () => {
  assert.equal(totalFromSeverity({ 0: 4, 1: 3, 2: 2, 3: 1, 4: 0 }), 10);
  assert.equal(totalFromSeverity({}), 0);
});
