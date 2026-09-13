import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret-that-is-long-enough';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret-that-is-long-enough';
process.env.CSRF_SECRET = 'test-csrf-secret-that-is-long-enough';
const { decodeAuditCursor, encodeAuditCursor, redactAuditReason } = await import('./audit-logs.js');
const { ApiError } = await import('../lib/http.js');

const auditId = '00000000-0000-4000-8000-000000000001';
const auditFilter = 'audit-filter-fingerprint';
const validCursor = { v: 2, filter: auditFilter, createdAt: '2026-09-13T12:34:56.123456Z', id: auditId };

function packCursor(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function assertCursorError(value: string, code = 'VALIDATION_ERROR', filter = auditFilter) {
  assert.throws(() => decodeAuditCursor(value, filter), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 400);
    assert.equal(error.code, code);
    return true;
  });
}

test('audit reason output trims likely credential assignments without returning JSON details', () => {
  assert.equal(redactAuditReason('password=exposed token: abc123 normal text'), 'password: [redacted] token: [redacted] normal text');
  assert.equal(redactAuditReason(null), null);
  assert.equal(redactAuditReason('x'.repeat(700))?.length, 500);
});

test('audit cursor v2 preserves the exact PostgreSQL microsecond timestamp', () => {
  const value = encodeAuditCursor({ log_id: auditId, cursor_created_at: validCursor.createdAt }, auditFilter);
  assert.deepEqual(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')), validCursor);
  assert.deepEqual(decodeAuditCursor(value, auditFilter), validCursor);
  assert.equal(decodeAuditCursor(undefined, auditFilter), null);
});

test('audit cursors distinguish rows within the same millisecond', () => {
  const first = encodeAuditCursor({ log_id: auditId, cursor_created_at: '2026-09-13T12:34:56.123001Z' }, auditFilter);
  const second = encodeAuditCursor({ log_id: auditId, cursor_created_at: '2026-09-13T12:34:56.123999Z' }, auditFilter);
  assert.notEqual(first, second);
  assert.equal(decodeAuditCursor(first, auditFilter)?.createdAt, '2026-09-13T12:34:56.123001Z');
  assert.equal(decodeAuditCursor(second, auditFilter)?.createdAt, '2026-09-13T12:34:56.123999Z');
});

test('a valid legacy audit cursor requires a pagination restart', () => {
  assertCursorError(packCursor({ ...validCursor, v: 1, createdAt: '2026-09-13T12:34:56.123Z' }), 'CURSOR_RESTART_REQUIRED');
});

test('audit cursors bind both versions to the current filter', () => {
  assertCursorError(packCursor(validCursor), 'VALIDATION_ERROR', 'another-filter');
  assertCursorError(packCursor({ ...validCursor, v: 1, createdAt: '2026-09-13T12:34:56.123Z' }), 'VALIDATION_ERROR', 'another-filter');
});

test('audit cursor v2 rejects impossible dates, non-UTC timestamps, and incomplete precision', () => {
  for (const createdAt of [
    null,
    undefined,
    0,
    '2026-02-29T12:34:56.123456Z',
    '2026-04-31T12:34:56.123456Z',
    '2026-13-01T12:34:56.123456Z',
    '2026-09-13T24:00:00.123456Z',
    '2026-09-13T12:34:60.123456Z',
    '2026-09-13T12:34:56.123456+00:00',
    '2026-09-13T20:34:56.123456+08:00',
    '2026-09-13T12:34:56.123456',
    '2026-09-13T12:34:56.123Z',
    '2026-09-13T12:34:56.12345Z',
    '2026-09-13T12:34:56.1234567Z',
    '2026-09-13',
  ]) {
    assertCursorError(packCursor({ ...validCursor, createdAt }));
  }
});

test('malformed legacy audit cursors remain validation errors', () => {
  for (const createdAt of [null, '2026-02-29T12:34:56.123Z', '2026-09-13T12:34:56.123+00:00', '2026-09-13', validCursor.createdAt]) {
    assertCursorError(packCursor({ ...validCursor, v: 1, createdAt }));
  }
  assertCursorError(packCursor({ ...validCursor, v: 1, createdAt: '2026-09-13T12:34:56.123Z', id: 'invalid-id' }));
});

test('audit cursors reject malformed payloads, encodings, identifiers, and unknown versions', () => {
  for (const payload of [null, [], 'cursor', {}, { ...validCursor, id: null }, { ...validCursor, id: 'invalid-id' }, { ...validCursor, v: 3 }, { ...validCursor, v: '2' }]) {
    assertCursorError(packCursor(payload));
  }
  for (const value of ['%%%invalid', Buffer.from('{invalid json').toString('base64url'), `${packCursor(validCursor)}=`, `${packCursor(validCursor)}!`]) {
    assertCursorError(value);
  }
});
