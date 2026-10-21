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
const { ApiError } = await import('../lib/http.js');
type VerificationOutcome = import('./upload-verification.js').VerificationOutcome;

const actorId = '11111111-1111-4111-8111-111111111111';
const courseRunId = '22222222-2222-4222-8222-222222222222';
const assetId = '33333333-3333-4333-8333-333333333333';
const incomingKey = 'incoming/course/test-file.pdf';

const accepted: VerificationOutcome = { kind: 'accepted', objectKey: 'course/test-file.pdf', mediaType: 'application/pdf', scanned: true };
const rejected: VerificationOutcome = { kind: 'rejected', verdict: {
  accepted: false, reason: 'executable_disguised', eventType: 'upload.executable_blocked', detected: 'pe',
  detail: 'declared application/pdf, content is a pe executable' } };

function fixture({ status = 'pending', owner = actorId, certified = true, expired = false,
  verify = async (): Promise<VerificationOutcome> => accepted, swapKeyDuringVerify = false } = {}) {
  let committedStatus = status;
  let committedKey = incomingKey;
  let commits = 0;
  let rollbacks = 0;
  let heads = 0;
  let verifies = 0;
  const deleted: string[] = [];
  const request = { params: { courseRunId, assetId }, ip: '203.0.113.9', get: () => undefined } as unknown as Request;
  const response = { locals: { actor: { id: actorId, roles: ['trainer'] } }, status() { return this; }, json(value: unknown) { return value; } } as unknown as Response;
  const row = { course_delivery_asset_id: assetId, course_run_id: courseRunId, owner_user_id: actorId,
    asset_purpose: 'cloud_download', bucket_name: 'test-bucket',
    original_filename: 'test.pdf', declared_content_type: 'application/pdf', declared_byte_size: '10',
    verified_content_type: null, verified_byte_size: null, etag: null,
    upload_expires_at: new Date(Date.now() + (expired ? -60_000 : 60_000)) };
  const withTransaction = async <T>(work: (client: PoolClient) => Promise<T>) => {
    let pendingStatus = committedStatus;
    let pendingKey = committedKey;
    const client = { query: async (sql: string, values: unknown[] = []) => {
      let rows: unknown[] = [];
      if (sql.includes('FROM course_runs cr JOIN courses')) rows = [{ owner_user_id: owner, publication_status: 'draft', run_status: 'draft' }];
      else if (sql.includes('FROM trainer_certifications')) rows = certified ? [{}] : [];
      else if (sql.includes('FROM course_delivery_assets')) rows = [{ ...row, object_key: pendingKey, asset_status: pendingStatus }];
      else if (sql.includes("SET asset_status = 'quarantined'")) pendingStatus = 'quarantined';
      else if (sql.includes("SET asset_status = 'ready'")) {
        pendingStatus = 'ready'; pendingKey = String(values[4]);
        rows = [{ ...row, object_key: pendingKey, asset_status: 'ready', verified_content_type: 'application/pdf', verified_byte_size: '10' }];
      }
      return { rows, rowCount: rows.length };
    } } as unknown as PoolClient;
    try {
      const result = await work(client);
      committedStatus = pendingStatus; committedKey = pendingKey; commits += 1; return result;
    } catch (error) { rollbacks += 1; throw error; }
  };
  return {
    request, response,
    state: () => ({ committedStatus, committedKey, commits, rollbacks, heads, verifies, deleted }),
    handler: (size: number) => createCourseUploadCompletionHandler({
      withTransaction,
      headObject: async () => { heads += 1; return { contentLength: size, contentType: 'application/pdf', etag: 'test-etag' }; },
      verify: async (object) => {
        verifies += 1;
        assert.equal(object.objectKey, incomingKey);
        assert.equal(object.etag, 'test-etag');
        if (swapKeyDuringVerify) committedKey = 'incoming/course/replacement.pdf';
        return verify();
      },
      deleteObject: async ({ objectKey }) => { deleted.push(objectKey); },
    }),
  };
}

test('mismatched course upload commits quarantine before returning HTTP 409, without inspecting', async () => {
  const f = fixture();
  await assert.rejects(f.handler(11)(f.request, f.response), { status: 409, code: 'UPLOAD_OBJECT_MISMATCH' });
  const state = f.state();
  assert.equal(state.committedStatus, 'quarantined');
  assert.equal(state.verifies, 0);
  assert.equal(state.rollbacks, 0);
});

test('inspected course upload becomes ready on its promoted key; the incoming copy is removed', async () => {
  const f = fixture();
  await f.handler(10)(f.request, f.response);
  // An already-ready retry neither re-reads R2 nor re-inspects.
  await f.handler(10)(f.request, f.response);
  const state = f.state();
  assert.equal(state.committedStatus, 'ready');
  assert.equal(state.committedKey, 'course/test-file.pdf');
  assert.deepEqual({ heads: state.heads, verifies: state.verifies, rollbacks: state.rollbacks }, { heads: 1, verifies: 1, rollbacks: 0 });
  assert.deepEqual(state.deleted, [incomingKey]);
});

test('W8: content that fails inspection is quarantined, deleted, and answered with a generic 422', async () => {
  const f = fixture({ verify: async () => rejected });
  await assert.rejects(f.handler(10)(f.request, f.response), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 422);
    assert.equal(error.code, 'UPLOAD_CONTENT_REJECTED');
    // Which check fired is recorded in the security ledger, not disclosed.
    assert.doesNotMatch(error.message, /executable|pe\b|signature/i);
    return true;
  });
  const state = f.state();
  assert.equal(state.committedStatus, 'quarantined');
  assert.equal(state.committedKey, incomingKey);
  assert.deepEqual(state.deleted, [incomingKey]);
});

test('W8: a scanner outage fails closed and leaves the upload pending for a retry', async () => {
  const f = fixture({ verify: async () => {
    throw new ApiError(503, 'UPLOAD_SCAN_UNAVAILABLE', 'The file could not be checked for malware right now.');
  } });
  await assert.rejects(f.handler(10)(f.request, f.response), { status: 503, code: 'UPLOAD_SCAN_UNAVAILABLE' });
  const state = f.state();
  assert.equal(state.committedStatus, 'pending');
  assert.deepEqual(state.deleted, []);
});

test('W8: a row that changed while its bytes were inspected is not marked ready', async () => {
  const f = fixture({ swapKeyDuringVerify: true });
  await assert.rejects(f.handler(10)(f.request, f.response), { status: 409, code: 'UPLOAD_NOT_PENDING' });
  assert.equal(f.state().committedStatus, 'pending');
});

test('unauthorised, uncertified, expired and deleted uploads never reach R2 verification', async () => {
  for (const input of [{ owner: 'other-account' }, { certified: false }, { expired: true }, { status: 'deleted' }]) {
    const f = fixture(input);
    await assert.rejects(f.handler(10)(f.request, f.response));
    assert.equal(f.state().heads, 0);
    assert.equal(f.state().verifies, 0);
    assert.equal(f.state().commits, 0);
    assert.equal(f.state().rollbacks, 1);
  }
});
