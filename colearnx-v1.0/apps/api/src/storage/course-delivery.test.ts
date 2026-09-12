import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import type { Request, Response } from 'express';

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret-that-is-long-enough';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret-that-is-long-enough';
process.env.CSRF_SECRET = 'test-csrf-secret-that-is-long-enough';
const { createCourseUploadCompletionHandler } = await import('./course-delivery.js');

const actorId = '11111111-1111-4111-8111-111111111111';
const courseRunId = '22222222-2222-4222-8222-222222222222';
const assetId = '33333333-3333-4333-8333-333333333333';

function fixture({ status = 'pending', owner = actorId, certified = true, expired = false } = {}) {
  let committedStatus = status;
  let commits = 0;
  let rollbacks = 0;
  let heads = 0;
  const request = { params: { courseRunId, assetId } } as unknown as Request;
  const response = { locals: { actor: { id: actorId, roles: ['trainer'] } }, status() { return this; }, json(value: unknown) { return value; } } as unknown as Response;
  const row = { course_delivery_asset_id: assetId, course_run_id: courseRunId, owner_user_id: actorId,
    asset_purpose: 'cloud_download', bucket_name: 'test-bucket', object_key: 'course/test-file',
    original_filename: 'test.pdf', declared_content_type: 'application/pdf', declared_byte_size: '10',
    verified_content_type: null, verified_byte_size: null, etag: null,
    upload_expires_at: new Date(Date.now() + (expired ? -60_000 : 60_000)) };
  const withTransaction = async <T>(work: (client: PoolClient) => Promise<T>) => {
    let pendingStatus = committedStatus;
    const client = { query: async (sql: string) => {
      let rows: unknown[] = [];
      if (sql.includes('FROM course_runs cr JOIN courses')) rows = [{ owner_user_id: owner, publication_status: 'draft', run_status: 'draft' }];
      else if (sql.includes('FROM trainer_certifications')) rows = certified ? [{}] : [];
      else if (sql.includes('FROM course_delivery_assets')) rows = [{ ...row, asset_status: pendingStatus }];
      else if (sql.includes("SET asset_status = 'quarantined'")) pendingStatus = 'quarantined';
      else if (sql.includes("SET asset_status = 'ready'")) {
        pendingStatus = 'ready'; rows = [{ ...row, asset_status: 'ready', verified_content_type: 'application/pdf', verified_byte_size: '10' }];
      }
      return { rows, rowCount: rows.length };
    } } as unknown as PoolClient;
    try { const result = await work(client); committedStatus = pendingStatus; commits += 1; return result; }
    catch (error) { rollbacks += 1; throw error; }
  };
  return {
    request, response,
    state: () => ({ committedStatus, commits, rollbacks, heads }),
    handler: (size: number) => createCourseUploadCompletionHandler({ withTransaction, headObject: async () => {
      heads += 1; return { contentLength: size, contentType: 'application/pdf', etag: 'test-etag' };
    } }),
  };
}

test('mismatched course upload commits quarantine before returning HTTP 409', async () => {
  const f = fixture();
  await assert.rejects(f.handler(11)(f.request, f.response), { status: 409, code: 'UPLOAD_OBJECT_MISMATCH' });
  assert.deepEqual(f.state(), { committedStatus: 'quarantined', commits: 1, rollbacks: 0, heads: 1 });
});

test('matching course upload becomes ready, and an already-ready retry skips R2', async () => {
  const f = fixture();
  await f.handler(10)(f.request, f.response);
  await f.handler(10)(f.request, f.response);
  assert.deepEqual(f.state(), { committedStatus: 'ready', commits: 2, rollbacks: 0, heads: 1 });
});

test('unauthorised, uncertified, expired and deleted uploads never reach R2 verification', async () => {
  for (const input of [{ owner: 'other-account' }, { certified: false }, { expired: true }, { status: 'deleted' }]) {
    const f = fixture(input);
    await assert.rejects(f.handler(10)(f.request, f.response));
    assert.equal(f.state().heads, 0);
    assert.equal(f.state().commits, 0);
    assert.equal(f.state().rollbacks, 1);
  }
});
