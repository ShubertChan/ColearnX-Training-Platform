import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret-that-is-long-enough';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret-that-is-long-enough';
process.env.CSRF_SECRET = 'test-csrf-secret-that-is-long-enough';
process.env.ENABLE_HOSTED_VIDEO = 'true';
process.env.VIDEO_PLAYBACK_TOKEN_SECRET = 'test-playback-token-secret-that-is-long-enough';
process.env.VIDEO_PLAYBACK_GATEWAY_ORIGIN = 'http://localhost:8787';
const { createPlaybackSessionHandler } = await import('./service.js');
const { createCourse, updateCourse } = await import('../catalog/catalog.js');
const buyer = '11111111-1111-4111-8111-111111111111';
const item = '22222222-2222-4222-8222-222222222222';
const version = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-10-01T00:00:00.000Z');
function fixture(startsAt: Date | null, actorId = buyer, published = false) {
  let issued = 0;
  const client = { query: async (sql: string) => {
    if (sql.includes('JOIN orders o')) return { rows: [{ buyer_user_id: buyer, fulfilment_status: 'fulfilled', course_video_version_id: version, duration_seconds: '100', hls_master_key: `course-video-hls/${version}/master.m3u8`, starts_at: startsAt, server_time: now, run_status: published ? 'published' : 'draft', publication_status: published ? 'published' : 'draft' }], rowCount: 1 };
    if (sql.includes('INSERT INTO course_video_progress_sessions')) issued++;
    if (sql.includes('MAX(interval_end_seconds)')) return { rows: [{ resume_at: '4' }], rowCount: 1 };
    return { rows: [{ course_video_version_id: version }], rowCount: 1 };
  } } as unknown as PoolClient;
  const req = { params: { orderItemId: item } } as unknown as Request;
  const res = { locals: { actor: { id: actorId, roles: ['member'] } }, set() { return this; }, status() { return this; }, json(value: unknown) { return value; } } as unknown as Response;
  return { req, res, issued: () => issued, handler: createPlaybackSessionHandler({ withTransaction: async <T>(work: (client: PoolClient) => Promise<T>) => work(client) }) };
}
test('a future course cannot issue a playback token, regardless of client clock', async () => {
  const f = fixture(new Date(now.getTime() + 1));
  await assert.rejects(f.handler(f.req, f.res), { status: 403, code: 'COURSE_NOT_STARTED' });
  assert.equal(f.issued(), 0);
});
test('missing start time fails closed without issuing a session', async () => {
  const f = fixture(null);
  await assert.rejects(f.handler(f.req, f.res), { status: 409, code: 'COURSE_START_REQUIRED' });
  assert.equal(f.issued(), 0);
});

test('a published undated course is not automatically classified as development data', async () => {
  const f = fixture(null, buyer, true);
  await assert.rejects(f.handler(f.req, f.res), { status: 409, code: 'COURSE_START_REQUIRED' });
  assert.equal(f.issued(), 0);
});

test('publication does not bypass a recorded future start time', async () => {
  const f = fixture(new Date(now.getTime() + 1), buyer, true);
  await assert.rejects(f.handler(f.req, f.res), { status: 403, code: 'COURSE_NOT_STARTED' });
  assert.equal(f.issued(), 0);
});

test('at and after the server-recorded start time playback retains version binding and resume position', async () => {
  for (const offset of [0, -1]) {
    const f = fixture(new Date(now.getTime() + offset));
    const result = await f.handler(f.req, f.res) as unknown as { data: { videoVersionId: string; resumeAt: number; authorization: { token: string } } };
    assert.equal(result.data.videoVersionId, version); assert.equal(result.data.resumeAt, 4);
    assert.match(result.data.authorization.token, /^v1\./); assert.equal(f.issued(), 1);
  }
});
test('opening time does not grant another buyer access', async () => {
  const f = fixture(now, 'other-buyer');
  await assert.rejects(f.handler(f.req, f.res), { code: 'PLAYBACK_UNAUTHORISED' }); assert.equal(f.issued(), 0);
});
test('create and update endpoints reject video metadata without a start time before database access', async () => {
  const req = { params: { id: item }, body: { title: 'Video', pricePoints: 20, deliveryModes: ['cloud'], progressTrackingType: 'online_video' } } as unknown as Request;
  const res = { locals: { actor: { id: buyer, roles: ['trainer'] } } } as unknown as Response;
  for (const handler of [createCourse, updateCourse]) await assert.rejects(handler(req, res), { code: 'VALIDATION_ERROR' });
});
