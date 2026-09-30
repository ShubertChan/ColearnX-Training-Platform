import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Request, Response } from 'express';

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret-that-is-long-enough';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret-that-is-long-enough';
process.env.CSRF_SECRET = 'test-csrf-secret-that-is-long-enough';
const { createContentUploadIntentHandler } = await import('./content-assets.js');
const { createCourseUploadIntentHandler } = await import('./course-delivery.js');

const owner = '11111111-1111-4111-8111-111111111111';
const draft = '22222222-2222-4222-8222-222222222222';
const assetId = '33333333-3333-4333-8333-333333333333';
const metadata = { filename: 'lesson.mp4', mediaType: 'video/mp4', sizeBytes: 100 };

function fixture(kind: 'content' | 'course', status = 'pending', expired = true, pendingUploads = 0) {
  const parent = kind === 'content' ? { contentVersionId: draft } : { courseRunId: draft };
  const fingerprint = createHash('sha256').update(JSON.stringify({ ...parent, ...metadata })).digest('hex');
  const row = {
    storage_asset_id: assetId, course_delivery_asset_id: assetId, content_version_id: draft, course_run_id: draft,
    owner_user_id: owner, bucket_name: 'test-bucket', object_key: 'test/lesson.mp4',
    original_filename: 'lesson.mp4', declared_content_type: 'video/mp4', declared_byte_size: '100',
    verified_content_type: status === 'ready' ? 'video/mp4' : null, verified_byte_size: status === 'ready' ? '100' : null,
    asset_status: status, upload_expires_at: new Date(Date.now() + (expired ? -120_000 : 60_000)), asset_purpose: 'cloud_download',
  };
  let inserts = 0, signs = 0;
  const client = { query: async (sql: string, values: unknown[]) => {
    let rows: unknown[] = [];
    if (sql.includes('FROM content_versions cv JOIN contents')) rows = [{ creator_user_id: owner, publication_status: 'draft', version_status: 'draft' }];
    else if (sql.includes('FROM course_runs cr JOIN courses')) rows = [{ owner_user_id: owner, publication_status: 'draft', run_status: 'draft' }];
    else if (sql.includes('FROM trainer_certifications')) rows = [{}];
    else if (sql.includes('FROM idempotency_records')) rows = [{ request_fingerprint: fingerprint, response_body: { assetId, expiresAt: row.upload_expires_at.toISOString() } }];
    else if (sql.includes('account_assets')) rows = [{ used_bytes: '100', pending_uploads: String(pendingUploads) }];
    else if (sql.includes('INSERT INTO')) inserts++;
    else if (/^\s*UPDATE\s/.test(sql) && sql.includes('upload_expires_at')) { row.upload_expires_at = values[1] as Date; rows = [row]; }
    else if (sql.includes('FROM storage_assets') || sql.includes('FROM course_delivery_assets')) rows = [row];
    return { rows, rowCount: rows.length };
  } } as unknown as PoolClient;
  const dependencies = {
    withTransaction: async <T>(work: (client: PoolClient) => Promise<T>) => work(client),
    signUpload: async () => { signs++; return 'https://upload.example/same-object'; },
  };
  const handler = kind === 'content' ? createContentUploadIntentHandler(dependencies) : createCourseUploadIntentHandler(dependencies);
  const req = { params: parent, body: metadata, get: () => 'same-upload-request-key' } as unknown as Request;
  let responseBody: { data: { assetId: string; uploadUrl?: string; status?: string } };
  const res = { locals: { actor: { id: owner, roles: [kind === 'content' ? 'creator' : 'trainer'] } },
    status() { return this; }, json(value: typeof responseBody) { responseBody = value; return this; } } as unknown as Response;
  return { handler: async () => { await handler(req, res); return responseBody; },
    counters: () => ({ inserts, signs }), row };
}

for (const kind of ['content', 'course'] as const) {
  test(`${kind} retry renews an expired pending upload without reserving another file`, async () => {
    const f = fixture(kind);
    const result = await f.handler();
    assert.equal(result.data.assetId, assetId);
    assert.equal(result.data.uploadUrl, 'https://upload.example/same-object');
    assert.ok(f.row.upload_expires_at.getTime() > Date.now());
    assert.deepEqual(f.counters(), { inserts: 0, signs: 1 });
  });
  test(`${kind} retry returns an already-ready file without issuing another upload URL`, async () => {
    const f = fixture(kind, 'ready');
    const result = await f.handler();
    assert.equal(result.data.status, 'ready');
    assert.equal(result.data.assetId, assetId);
    assert.equal(result.data.uploadUrl, undefined);
    assert.deepEqual(f.counters(), { inserts: 0, signs: 0 });
  });
  test(`${kind} retry cannot resurrect a deleted or quarantined file`, async () => {
    for (const status of ['deleted', 'delete_pending', 'quarantined']) {
      const f = fixture(kind, status);
      await assert.rejects(f.handler(), { status: 409 });
      assert.equal(f.counters().signs, 0);
    }
  });
  test(`${kind} expired retry preserves the account active-upload limit`, async () => {
    const f = fixture(kind, 'pending', true, 3);
    const expiry = f.row.upload_expires_at.getTime();
    await assert.rejects(f.handler(), { status: 429, code: 'CONTENT_UPLOAD_PENDING_LIMIT' });
    assert.equal(f.row.upload_expires_at.getTime(), expiry);
    assert.deepEqual(f.counters(), { inserts: 0, signs: 0 });
  });
}
