import assert from 'node:assert/strict';
import test from 'node:test';
import { isExactUtcTimestamp, isLegacyUtcTimestamp } from './pagination-timestamps.js';

test('cursor timestamp validation accepts UTC microseconds without truncating them', () => {
  for (const value of ['2026-09-13T01:02:03.123456Z', '2024-02-29T23:59:59.999999Z', '2026-09-13T01:02:03.123000Z']) {
    assert.equal(isExactUtcTimestamp(value), true);
    assert.equal(isLegacyUtcTimestamp(value), false);
  }
  assert.equal(isLegacyUtcTimestamp('2026-09-13T01:02:03.123Z'), true);
});

test('cursor timestamp validation rejects impossible dates, imprecise values and non-UTC forms', () => {
  for (const value of [null, undefined, 123, '', '0000-01-01T00:00:00.000000Z', '2026-02-29T01:02:03.123456Z',
    '2026-02-30T01:02:03.123456Z', '2026-09-13T24:00:00.000000Z',
    '2026-09-13T01:02:60.000000Z', '2026-09-13T01:02:03.123Z',
    '2026-09-13T01:02:03.1234567Z', '2026-09-13T01:02:03.123456+00:00',
    '2026-09-13 01:02:03.123456Z', '2026-09-13']) {
    assert.equal(isExactUtcTimestamp(value), false, String(value));
  }
  assert.equal(isLegacyUtcTimestamp('2026-02-30T01:02:03.123Z'), false);
});
