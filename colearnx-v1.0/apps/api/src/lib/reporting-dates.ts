import { ApiError } from './http.js';

export type UtcDateRange = { from: string; to: string };

function utcDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addUtcDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return utcDate(value);
}

function isValidDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && utcDate(parsed) === value;
}

/** Resolves a UTC-inclusive calendar range with a bounded 90-day window. */
export function resolveUtcDateRange(input: { from?: string; to?: string }, now = new Date()): UtcDateRange {
  if (input.from && !isValidDate(input.from)) throw new ApiError(400, 'VALIDATION_ERROR', 'The request is invalid.', { from: 'Use YYYY-MM-DD.' });
  if (input.to && !isValidDate(input.to)) throw new ApiError(400, 'VALIDATION_ERROR', 'The request is invalid.', { to: 'Use YYYY-MM-DD.' });
  const today = utcDate(now);
  const to = input.to ?? today;
  const from = input.from ?? addUtcDays(to, -29);
  if (from > to) throw new ApiError(400, 'VALIDATION_ERROR', 'The request is invalid.', { range: 'from cannot be after to.' });
  if (addUtcDays(from, 89) < to) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The request is invalid.', { range: 'The maximum range is 90 UTC days.' });
  }
  return { from, to };
}

export function utcDates(range: UtcDateRange) {
  const dates: string[] = [];
  for (let date = range.from; date <= range.to; date = addUtcDays(date, 1)) dates.push(date);
  return dates;
}
