import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import MarketplaceDateFilter from "../../src/components/MarketplaceDateFilter";
import { setLanguage } from "../../src/i18n/LanguageContext";

beforeEach(() => setLanguage("en"));
afterEach(() => act(() => setLanguage("en")));
const open = () => fireEvent.click(screen.getByRole("button", { name: "Open calendar" }));
const day = value => document.querySelector(`[data-date="${value}"]`);

test("date calendar stays English and sends the ISO date used by marketplace filters", () => {
  const change = vi.fn();
  render(<MarketplaceDateFilter value="2028-02-01" onChange={change} />);
  open();
  expect(screen.getByRole("option", { name: "February" })).toBeTruthy();
  expect(screen.getByText("Mon")).toBeTruthy();
  fireEvent.click(day("2028-02-29"));
  fireEvent.click(screen.getByRole("button", { name: "Apply date" }));
  expect(change).toHaveBeenCalledWith("2028-02-29");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("calendar changes months, preserves the selected date, and clears the filter", () => {
  const change = vi.fn();
  render(<MarketplaceDateFilter value="2026-12-31" onChange={change} />);
  open();
  expect(day("2026-12-31").closest('[role="gridcell"]').getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Next month" }));
  expect(screen.getByRole("combobox", { name: "Calendar month" }).value).toBe("1");
  fireEvent.click(screen.getByRole("button", { name: "Clear date" }));
  expect(change).toHaveBeenCalledWith("");
});

test("dismissing the calendar preserves the filter and returns focus", () => {
  const change = vi.fn();
  render(<MarketplaceDateFilter value="2026-10-08" onChange={change} />);
  const trigger = screen.getByRole("button", { name: "Open calendar" });
  trigger.focus();
  fireEvent.click(trigger);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(change).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
});

test("site language switches without changing the filter date", () => {
  const change = vi.fn();
  render(<MarketplaceDateFilter value="2026-10-08" onChange={change} />);
  open();
  act(() => setLanguage("zh-CN"));
  expect(screen.getByRole("dialog", { name: "选择日期" })).toBeTruthy();
  expect(screen.getByRole("textbox").value).toBe("2026-10-08");
  expect(change).not.toHaveBeenCalled();
});
