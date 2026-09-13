import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret-that-is-long-enough';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret-that-is-long-enough';
process.env.CSRF_SECRET = 'test-csrf-secret-that-is-long-enough';
const { createApp } = await import('./app.js');

test('reports and operations routes are registered behind authentication rather than the 404 fallback', async () => {
  const app = createApp();
  for (const [method, path] of [
    ['post', '/api/v1/reports'],
    ['get', '/api/v1/admin/reports'],
    ['post', '/api/v1/admin/reports/11111111-1111-4111-8111-111111111111/decision'],
    ['get', '/api/v1/admin/audit-logs'],
    ['get', '/api/v1/admin/activity-report'],
  ] as const) {
    const response = await request(app)[method](path);
    assert.equal(response.status, 401, `${method} ${path} should reach authenticate before notFound`);
    assert.equal(response.body.error.code, 'AUTH_REQUIRED');
  }
});
