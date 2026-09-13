import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret-that-is-long-enough';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret-that-is-long-enough';
process.env.CSRF_SECRET = 'test-csrf-secret-that-is-long-enough';
const { decodeReportCursor, encodeReportCursor } = await import('./reports.js');

const report = {
  id: '11111111-1111-4111-8111-111111111111', kind: 'content', productId: '22222222-2222-4222-8222-222222222222', title: 'Example',
  category: 'misleading', reason: 'The supplied resource differs from its description.', status: 'pending', createdAt: '2026-09-13T00:00:00.000Z',
  reporter: { id: '33333333-3333-4333-8333-333333333333', displayName: 'Member' }, reviewer: null, reviewedAt: null, decisionReason: null,
};

test('report cursors bind pagination to its status and stable sort position', () => {
  const cursor = encodeReportCursor(report, 'pending');
  assert.deepEqual(decodeReportCursor(cursor, 'pending'), {
    v: 1, status: 'pending', createdAt: '2026-09-13T00:00:00.000Z', id: report.id,
  });
  assert.throws(() => decodeReportCursor(cursor, 'dismissed'), { status: 400, code: 'VALIDATION_ERROR' });
});

test('malformed report cursors are validation errors rather than database input', () => {
  assert.throws(() => decodeReportCursor('not-a-cursor', 'pending'), { status: 400, code: 'VALIDATION_ERROR' });
});
