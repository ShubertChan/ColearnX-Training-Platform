import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveUtcDateRange, utcDates } from './reporting-dates.js';

test('the default reporting range is the latest 30 UTC calendar days', () => {
  assert.deepEqual(resolveUtcDateRange({}, new Date('2026-09-13T15:30:00.000Z')), { from: '2026-08-15', to: '2026-09-13' });
});

test('reporting dates are inclusive, UTC, and complete empty days', () => {
  const range = resolveUtcDateRange({ from: '2026-09-10', to: '2026-09-13' });
  assert.deepEqual(utcDates(range), ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13']);
});

test('invalid, reversed, and overlong reporting ranges are rejected', () => {
  assert.throws(() => resolveUtcDateRange({ from: '2026-02-30' }), { status: 400, code: 'VALIDATION_ERROR' });
  assert.throws(() => resolveUtcDateRange({ from: '2026-09-14', to: '2026-09-13' }), { status: 400, code: 'VALIDATION_ERROR' });
  assert.throws(() => resolveUtcDateRange({ from: '2026-01-01', to: '2026-04-01' }), { status: 400, code: 'VALIDATION_ERROR' });
});
