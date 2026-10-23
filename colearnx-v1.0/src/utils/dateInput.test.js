import assert from "node:assert/strict";
import test from "node:test";
import { calendarDay, dateInputError, daysInMonth, displayDateInput, monthDays, normalizeDateInput, shiftCalendarDay, shiftCalendarMonth, utcCalendarDate } from "./dateInput.js";

test("date values have a fixed year-month-day order and reject impossible dates", () => {
  assert.equal(normalizeDateInput("2024-02-29"), "2024-02-29");
  assert.equal(normalizeDateInput("2026/10/23"), "2026-10-23");
  for (const value of ["2026-02-29", "2026-04-31", "2026-00-01", "2026-13-01", "2026-10-00", "0000-01-01", "10/23/2026", "2026-10"]) assert.equal(normalizeDateInput(value), null, value);
  assert.equal(daysInMonth(1900, 2), 28); assert.equal(daysInMonth(2000, 2), 29);
  assert.equal(normalizeDateInput(""), "");
});
test("24-hour local time is normalized without creating a timezone conversion", () => {
  assert.equal(normalizeDateInput("2026-10-23 14:05", true), "2026-10-23T14:05");
  assert.equal(normalizeDateInput("2026-10-23T00:00", true), "2026-10-23T00:00");
  assert.equal(displayDateInput("2026-10-23T14:05"), "2026-10-23 14:05");
  for (const value of ["2026-10-23 24:00", "2026-10-23 23:60", "2026-10-23 1:30", "2026-10-23"]) assert.equal(normalizeDateInput(value, true), null);
});
test("range endpoints are inclusive and invalid input does not silently roll to another date", () => {
  const range = { min: "2026-10-20", max: "2026-10-23" };
  assert.equal(dateInputError("2026-10-20", range), "");
  assert.equal(dateInputError("2026-10-23", range), "");
  assert.ok(dateInputError("2026-10-24", range));
  assert.ok(dateInputError("2026-10-19", range));
  assert.ok(dateInputError("2026-02-30", range));
  assert.ok(dateInputError("2026-10-23 09:00", { withTime: true, min: "2026-10-23T10:00" }));
});
test("calendar rows span month and year boundaries without DST or date-only timezone shifts", () => {
  const days = monthDays(2026, 10);
  assert.equal(days.length, 42); assert.equal(days[0], "2026-09-28"); assert.equal(days[41], "2026-11-08");
  assert.equal(shiftCalendarDay("2024-02-28", 1), "2024-02-29");
  assert.equal(shiftCalendarDay("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftCalendarDay("2026-03-08", 1), "2026-03-09");
  assert.equal(calendarDay(utcCalendarDate("0042-01-01")), "0042-01-01");
  assert.equal(shiftCalendarMonth("2024-01-31", 1), "2024-02-29");
  assert.equal(shiftCalendarMonth("2026-03-31", -1), "2026-02-28");
});
