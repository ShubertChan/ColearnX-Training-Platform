import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import DateInput from "../../src/components/DateInput";
import { setLanguage } from "../../src/i18n/LanguageContext";

const change = vi.fn(), submit = vi.fn();
function Field({ initial = "", ...props }) {
  const [value, setValue] = useState(initial);
  return <form onSubmit={event => { event.preventDefault(); submit(); }}><label>Schedule<DateInput aria-label="Schedule" value={value} onChange={event => { setValue(event.target.value); change(event.target.value); }} {...props} /></label><output data-testid="value">{value}</output><button type="submit">Save</button></form>;
}
beforeEach(() => { setLanguage("en"); vi.clearAllMocks(); });
afterEach(() => act(() => setLanguage("en")));
const open = () => fireEvent.click(screen.getByRole("button", { name: "Open calendar" }));
const day = value => document.querySelector(`[data-date="${value}"]`);

test("empty placeholders and calendar controls follow site language without changing the typed value", () => {
  render(<Field />);
  const input = screen.getByLabelText("Schedule");
  expect(input.placeholder).toBe("YYYY-MM-DD");
  fireEvent.change(input, { target: { value: "2026-10-23" } }); open();
  act(() => setLanguage("zh-CN"));
  expect(input.placeholder).toBe("年-月-日"); expect(input.value).toBe("2026-10-23");
  expect(screen.getByRole("dialog", { name: "选择日期" })).not.toBeNull();
  expect(screen.getByRole("combobox", { name: "日历月份" }).value).toBe("10");
  expect(day("2026-10-23").closest('[role="gridcell"]').getAttribute("aria-selected")).toBe("true");
  expect(change).toHaveBeenCalledTimes(1);
  act(() => setLanguage("en"));
  expect(screen.getByRole("dialog", { name: "Choose date" })).not.toBeNull();
  expect(input.value).toBe("2026-10-23"); expect(submit).not.toHaveBeenCalled();
});

test("invalid and partially typed dates remain visible and block form validation across language changes", () => {
  render(<Field initial="2026-10-23" required />);
  const input = screen.getByLabelText("Schedule");
  fireEvent.change(input, { target: { value: "2026-02-30" } }); fireEvent.blur(input);
  expect(input.checkValidity()).toBe(false); expect(change).not.toHaveBeenCalled();
  act(() => setLanguage("zh-CN"));
  expect(input.value).toBe("2026-02-30"); expect(input.validationMessage).toContain("请输入有效日期");
  expect(screen.getByRole("alert").textContent).toContain("2026-10-23");
  fireEvent.change(input, { target: { value: "2026-02-28" } });
  expect(input.checkValidity()).toBe(true); expect(change).toHaveBeenLastCalledWith("2026-02-28");
});

test("date ranges disable excluded days and applying or clearing preserves ISO values", () => {
  render(<Field initial="2026-10-23" min="2026-10-20" max="2026-10-25" />);
  fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "2026-10-26" } });
  expect(change).not.toHaveBeenCalled(); expect(screen.getByLabelText("Schedule").checkValidity()).toBe(false);
  fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "2026-10-23" } }); change.mockClear(); open();
  expect(day("2026-10-19").disabled).toBe(true); expect(day("2026-10-26").disabled).toBe(true);
  fireEvent.click(day("2026-10-25"));
  expect(change).not.toHaveBeenCalled(); // Selecting is reversible until Apply.
  fireEvent.click(screen.getByRole("button", { name: "Apply date" }));
  expect(change).toHaveBeenLastCalledWith("2026-10-25"); expect(screen.queryByRole("dialog")).toBeNull();
  open(); fireEvent.click(screen.getByRole("button", { name: "Clear date" }));
  expect(screen.getByLabelText("Schedule").value).toBe(""); expect(change).toHaveBeenLastCalledWith(""); expect(submit).not.toHaveBeenCalled();
});

test("calendar supports leap days and 24-hour time without submitting the containing course form", () => {
  render(<Field type="datetime-local" initial="2024-01-31T09:00" required />); open();
  fireEvent.change(screen.getByRole("combobox", { name: "Calendar month" }), { target: { value: "2" } });
  fireEvent.click(day("2024-02-29"));
  fireEvent.change(screen.getByLabelText("Time (24-hour)"), { target: { value: "24:00" } });
  expect(screen.getByRole("button", { name: "Apply date" }).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Time (24-hour)"), { target: { value: "14:30" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply date" }));
  expect(change).toHaveBeenLastCalledWith("2024-02-29T14:30");
  expect(screen.getByLabelText("Schedule").value).toBe("2024-02-29 14:30"); expect(submit).not.toHaveBeenCalled();
});

test("keyboard navigation crosses month boundaries and Escape cancels without losing draft input", () => {
  render(<Field initial="2026-10-31" />); open();
  act(() => day("2026-10-31").focus());
  fireEvent.keyDown(day("2026-10-31"), { key: "ArrowRight" });
  expect(document.activeElement).toBe(day("2026-11-01"));
  fireEvent.keyDown(document.activeElement, { key: "ArrowDown" });
  expect(document.activeElement).toBe(day("2026-11-08"));
  fireEvent.keyDown(document.activeElement, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.getByLabelText("Schedule").value).toBe("2026-10-31");
  expect(change).not.toHaveBeenCalled();
});

test("disabled dates cannot open a picker and invalid external values still allow recovery", () => {
  const view = render(<DateInput aria-label="Schedule" value="bad-url-value" onChange={change} disabled />);
  expect(screen.getByRole("button", { name: "Open calendar" }).disabled).toBe(true);
  view.rerender(<DateInput aria-label="Schedule" value="bad-url-value" onChange={change} />);
  open(); expect(screen.getByRole("dialog")).not.toBeNull();
  expect(within(screen.getByRole("grid")).getAllByRole("button").length).toBe(42);
});
