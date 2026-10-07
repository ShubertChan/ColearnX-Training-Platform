import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret-that-is-long-enough';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret-that-is-long-enough';
process.env.CSRF_SECRET = 'test-csrf-secret-that-is-long-enough';

const {
  encodeSecurityCursor,
  decodeSecurityCursor,
  securityFilterFingerprint,
  fillDailySeries,
  summariseHighlights,
  SEVERE_THRESHOLD,
} = await import('./security-dashboard.js');
const { ApiError } = await import('../lib/http.js');

const eventId = '00000000-0000-4000-8000-000000000001';
const filterA = securityFilterFingerprint({ from: '2026-09-01', to: '2026-09-30', minSeverity: 0 });
const filterB = securityFilterFingerprint({ from: '2026-09-01', to: '2026-09-30', type: 'auth.login_failed', minSeverity: 2 });
const occurredAt = '2026-09-13T12:34:56.123456Z';

function pack(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function assertCursorError(value: string, filter = filterA) {
  assert.throws(() => decodeSecurityCursor(value, filter), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'VALIDATION_ERROR');
    return true;
  });
}

test('the filter fingerprint changes when any bound, type or minimum severity changes', () => {
  assert.notEqual(filterA, filterB);
  assert.equal(filterA, securityFilterFingerprint({ from: '2026-09-01', to: '2026-09-30', minSeverity: 0 }));
  assert.notEqual(filterA, securityFilterFingerprint({ from: '2026-09-02', to: '2026-09-30', minSeverity: 0 }));
});

test('a security cursor round-trips and preserves the exact PostgreSQL microsecond timestamp', () => {
  const value = encodeSecurityCursor({ id: eventId, cursorOccurredAt: occurredAt }, filterA);
  assert.deepEqual(decodeSecurityCursor(value, filterA), { v: 1, filter: filterA, occurredAt, id: eventId });
  assert.equal(decodeSecurityCursor(undefined, filterA), null);
});

test('security cursors distinguish rows inside the same millisecond', () => {
  const first = encodeSecurityCursor({ id: eventId, cursorOccurredAt: '2026-09-13T12:34:56.123001Z' }, filterA);
  const second = encodeSecurityCursor({ id: eventId, cursorOccurredAt: '2026-09-13T12:34:56.123999Z' }, filterA);
  assert.notEqual(first, second);
  assert.equal(decodeSecurityCursor(first, filterA)?.occurredAt, '2026-09-13T12:34:56.123001Z');
});

test('a security cursor is bound to the filter it was issued under', () => {
  const value = encodeSecurityCursor({ id: eventId, cursorOccurredAt: occurredAt }, filterA);
  assertCursorError(value, filterB);
});

test('malformed, non-UTC, imprecise and unknown-version cursors are validation errors', () => {
  for (const occurred of [
    null,
    '2026-02-29T12:34:56.123456Z',
    '2026-09-13T12:34:56.123Z',
    '2026-09-13T12:34:56.123456+00:00',
    '2026-09-13',
  ]) {
    assertCursorError(pack({ v: 1, filter: filterA, occurredAt: occurred, id: eventId }));
  }
  assertCursorError(pack({ v: 1, filter: filterA, occurredAt, id: 'not-a-uuid' }));
  assertCursorError(pack({ v: 2, filter: filterA, occurredAt, id: eventId }));
  for (const value of ['%%%bad', `${pack({ v: 1, filter: filterA, occurredAt, id: eventId })}=`]) assertCursorError(value);
});

test('the daily series fills every UTC day in the window, missing days as zero', () => {
  const series = fillDailySeries(
    [{ d: '2026-09-02', total: '7', severe: '2' }],
    { from: '2026-09-01', to: '2026-09-03' },
  );
  assert.deepEqual(series, [
    { date: '2026-09-01', total: 0, severe: 0 },
    { date: '2026-09-02', total: 7, severe: 2 },
    { date: '2026-09-03', total: 0, severe: 0 },
  ]);
});

test('highlights read named event types out of the by-type breakdown, defaulting to zero', () => {
  const highlights = summariseHighlights([
    { type: 'auth.login_failed', count: 12 },
    { type: 'access.rate_limited', count: 4 },
  ]);
  assert.equal(highlights.failedLogins, 12);
  assert.equal(highlights.rateLimited, 4);
  assert.equal(highlights.accountsLocked, 0);
  assert.equal(highlights.breachUnavailable, 0);
});

test('the severe threshold is the high/critical boundary', () => {
  assert.equal(SEVERE_THRESHOLD, 3);
});
