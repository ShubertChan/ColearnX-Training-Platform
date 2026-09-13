import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret-that-is-long-enough';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret-that-is-long-enough';
process.env.CSRF_SECRET = 'test-csrf-secret-that-is-long-enough';
const { redactAuditReason } = await import('./audit-logs.js');

test('audit reason output trims likely credential assignments without returning JSON details', () => {
  assert.equal(redactAuditReason('password=exposed token: abc123 normal text'), 'password: [redacted] token: [redacted] normal text');
  assert.equal(redactAuditReason(null), null);
  assert.equal(redactAuditReason('x'.repeat(700))?.length, 500);
});
