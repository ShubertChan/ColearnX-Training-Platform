// Date-only values must never pass through the device timezone or Date.parse.
// The API continues to receive YYYY-MM-DD / YYYY-MM-DDTHH:mm values.
export const daysInMonth = (year, month) => [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] || 0;

export function normalizeDateInput(text, withTime = false) {
  if (!text.trim()) return "";
  const match = text.trim().match(withTime
    ? /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})$/
    : /^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  if (+year < 1 || +month < 1 || +month > 12 || +day < 1 || +day > daysInMonth(+year, +month)) return null;
  if (withTime && (+hour > 23 || +minute > 59)) return null;
  return `${year}-${month}-${day}${withTime ? `T${hour}:${minute}` : ""}`;
}

export function dateInputError(text, { withTime = false, min = "", max = "" } = {}) {
  const value = normalizeDateInput(text, withTime);
  if (value === "") return ""; // Native required validation handles empty fields.
  if (value === null) return withTime ? "Enter a valid date and 24-hour time (YYYY-MM-DD HH:mm)." : "Enter a valid date (YYYY-MM-DD).";
  if (min && value < min) return { key: "Choose {min} or later.", values: { min: min.replace("T", " ") } };
  if (max && value > max) return { key: "Choose {max} or earlier.", values: { max: max.replace("T", " ") } };
  return "";
}

export const displayDateInput = value => (value || "").replace("T", " ");
export function utcCalendarDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}
export function calendarDay(value) {
  return `${String(value.getUTCFullYear()).padStart(4, "0")}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}
export function shiftCalendarDay(value, amount) {
  const date = utcCalendarDate(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return calendarDay(date);
}
export function shiftCalendarMonth(value, amount) {
  const date = utcCalendarDate(value);
  const day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + amount);
  date.setUTCDate(Math.min(day, daysInMonth(date.getUTCFullYear(), date.getUTCMonth() + 1)));
  return calendarDay(date);
}
export function monthDays(year, month) {
  const first = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
  const offset = (utcCalendarDate(first).getUTCDay() + 6) % 7; // Monday first.
  return Array.from({ length: 42 }, (_, index) => shiftCalendarDay(first, index - offset));
}
export function localToday(now = new Date()) {
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
