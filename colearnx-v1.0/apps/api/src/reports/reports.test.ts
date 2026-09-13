import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret-that-is-long-enough';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret-that-is-long-enough';
process.env.CSRF_SECRET = 'test-csrf-secret-that-is-long-enough';
const { decodeReportCursor, encodeReportCursor } = await import('./reports.js');

const report = {
  report_id: '11111111-1111-4111-8111-111111111111', cursor_created_at: '2026-09-13T00:00:00.123456Z',
};

test('report cursors bind pagination to its status and stable sort position', () => {
  const cursor = encodeReportCursor(report, 'pending');
  assert.deepEqual(decodeReportCursor(cursor, 'pending'), {
    v: 2, status: 'pending', createdAt: '2026-09-13T00:00:00.123456Z', id: report.report_id,
  });
  assert.throws(() => decodeReportCursor(cursor, 'dismissed'), { status: 400, code: 'VALIDATION_ERROR' });
});

test('malformed report cursors are validation errors rather than database input', () => {
  assert.throws(() => decodeReportCursor('not-a-cursor', 'pending'), { status: 400, code: 'VALIDATION_ERROR' });
  const valid = encodeReportCursor(report, 'pending');
  for (const value of [` ${valid}`, `${valid}=`, `${valid}!`]) {
    assert.throws(() => decodeReportCursor(value, 'pending'), { status: 400, code: 'VALIDATION_ERROR' });
  }
});

test('historical report null timestamps stay null in v2 cursors', () => {
  assert.deepEqual(decodeReportCursor(encodeReportCursor({ ...report, cursor_created_at: null }, 'pending'), 'pending'), {
    v: 2, status: 'pending', createdAt: null, id: report.report_id,
  });
});

test('valid old report cursors require restarting instead of reusing a lossy boundary', () => {
  for (const createdAt of ['2026-09-13T00:00:00.123Z', null]) {
    const cursor = Buffer.from(JSON.stringify({ v: 1, status: 'pending', createdAt, id: report.report_id })).toString('base64url');
    assert.throws(() => decodeReportCursor(cursor, 'pending'), { status: 400, code: 'CURSOR_RESTART_REQUIRED' });
    assert.throws(() => decodeReportCursor(cursor, 'resolved'), { status: 400, code: 'VALIDATION_ERROR' });
  }
});

test('report cursors reject malformed dates, invalid IDs and unsupported versions', () => {
  const valid = { v: 2, status: 'pending', createdAt: report.cursor_created_at, id: report.report_id };
  for (const changed of [{ createdAt: '2026-02-30T00:00:00.123456Z' },
    { createdAt: '2026-09-13T00:00:00.123Z' }, { createdAt: '2026-09-13T00:00:00.123456+00:00' },
    { createdAt: undefined }, { id: 'not-a-uuid' }, { v: 3 }, { v: 1, createdAt: 'not-a-date' }]) {
    const cursor = Buffer.from(JSON.stringify({ ...valid, ...changed })).toString('base64url');
    assert.throws(() => decodeReportCursor(cursor, 'pending'), { status: 400, code: 'VALIDATION_ERROR' });
  }
  for (const raw of ['null', '[]', 'false']) {
    assert.throws(() => decodeReportCursor(Buffer.from(raw).toString('base64url'), 'pending'), { status: 400, code: 'VALIDATION_ERROR' });
  }
});
