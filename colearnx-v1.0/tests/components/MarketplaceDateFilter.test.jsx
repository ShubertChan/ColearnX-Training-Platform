import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import MarketplaceDateFilter from "../../src/components/MarketplaceDateFilter";

test("date calendar stays English and sends the ISO date used by marketplace filters", () => {
  const change = vi.fn();
  render(<MarketplaceDateFilter value="2028-02-01" onChange={change} />);
  fireEvent.click(screen.getByRole("button", { name: /Starts on or after/ }));
  expect(screen.getByText("February 2028")).toBeTruthy();
  expect(screen.getByText("Mon")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "February 29, 2028" }));
  expect(change).toHaveBeenCalledWith("2028-02-29");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("calendar changes months, preserves the selected date, and clears the filter", () => {
  const change = vi.fn();
  render(<MarketplaceDateFilter value="2026-12-31" onChange={change} />);
  fireEvent.click(screen.getByRole("button", { name: /Starts on or after/ }));
  expect(screen.getByRole("button", { name: "December 31, 2026" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Next month" }));
  expect(screen.getByText("January 2027")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear date" }));
  expect(change).toHaveBeenCalledWith("");
});

test("dismissing the calendar preserves the filter and returns focus", () => {
  const change = vi.fn();
  render(<MarketplaceDateFilter value="2026-10-08" onChange={change} />);
  const trigger = screen.getByRole("button", { name: /Starts on or after/ });
  trigger.focus();
  fireEvent.click(trigger);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(change).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
});
