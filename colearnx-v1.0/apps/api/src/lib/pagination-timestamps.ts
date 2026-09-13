// Display dates may use JavaScript milliseconds. Keyset boundaries must retain
// PostgreSQL's full microsecond precision as text, without a Date round-trip.
function isUtcTimestamp(value: unknown, precision: 3 | 6): value is string {
  if (typeof value !== 'string') return false;
  const pattern = precision === 6
    ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  // PostgreSQL has no year zero, although JavaScript accepts ISO year 0000.
  if (!pattern.test(value) || value.startsWith('0000-')) return false;
  // Only validate the calendar here. The caller keeps the ORIGINAL string,
  // including the final three microsecond digits used by SQL comparisons.
  const milliseconds = `${value.slice(0, 23)}Z`;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) && date.toISOString() === milliseconds;
}

export const isExactUtcTimestamp = (value: unknown): value is string => isUtcTimestamp(value, 6);
export const isLegacyUtcTimestamp = (value: unknown): value is string => isUtcTimestamp(value, 3);
