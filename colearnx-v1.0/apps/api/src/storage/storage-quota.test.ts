import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { assertAccountStorageQuota, storageQuotaViolation } from './storage-quota.js';

const limits = { maxBytes: 250, maxPendingUploads: 3 };

test('allows an upload within the creator storage quota', () => {
  assert.equal(storageQuotaViolation({ ...limits, usedBytes: 200, pendingUploads: 1, requestedBytes: 50 }), null);
});

test('rejects an upload that would exceed the creator storage quota', () => {
  assert.equal(storageQuotaViolation({ ...limits, usedBytes: 201, pendingUploads: 1, requestedBytes: 50 })?.code, 'CONTENT_STORAGE_QUOTA_EXCEEDED');
});

test('rejects a fourth uncompleted upload even when storage remains', () => {
  assert.equal(storageQuotaViolation({ ...limits, usedBytes: 1, pendingUploads: 3, requestedBytes: 1 })?.code, 'CONTENT_UPLOAD_PENDING_LIMIT');
});

test('account quota queries content and course storage under the same transaction lock', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = { query: async (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    return { rows: sql.includes('account_assets') ? [{ used_bytes: '230', pending_uploads: '2' }] : [] };
  } } as unknown as PoolClient;
  await assert.rejects(assertAccountStorageQuota(client, 'same-account', 21, limits), { code: 'CONTENT_STORAGE_QUOTA_EXCEEDED' });
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(calls[0].values, ['same-account']);
  assert.match(calls[1].sql, /FROM storage_assets/);
  assert.match(calls[1].sql, /UNION ALL/);
  assert.match(calls[1].sql, /FROM course_delivery_assets/);
  assert.equal((calls[1].sql.match(/asset_status <> 'deleted'/g) ?? []).length, 2);
  assert.match(calls[1].sql, /GREATEST\(declared_byte_size/);
});

test('a shared account lock prevents concurrent Creator and Trainer reservations exceeding the cap', async () => {
  let tail = Promise.resolve();
  let usedBytes = 0;
  const recordedLocks: string[] = [];
  const reserve = async (kind: string) => {
    let release: (() => void) | undefined;
    const client = { query: async (sql: string, values: unknown[]) => {
      if (sql.includes('pg_advisory_xact_lock')) {
        recordedLocks.push(String(values[0]));
        const predecessor = tail;
        tail = new Promise<void>((done) => { release = done; });
        await predecessor;
        return { rows: [] };
      }
      assert.match(sql, /UNION ALL/);
      return { rows: [{ used_bytes: String(usedBytes), pending_uploads: '0' }] };
    } } as unknown as PoolClient;
    try {
      await assertAccountStorageQuota(client, 'multi-role-account', 150, limits);
      await Promise.resolve();
      usedBytes += 150;
      return kind;
    } finally { release?.(); }
  };
  const results = await Promise.allSettled([reserve('creator'), reserve('trainer')]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(usedBytes, 150);
  assert.deepEqual(recordedLocks, ['multi-role-account', 'multi-role-account']);
});

test('combined pending uploads reject a fourth account upload', async () => {
  const client = { query: async (sql: string) => ({ rows: sql.includes('account_assets')
    ? [{ used_bytes: '3', pending_uploads: '3' }] : [] }) } as unknown as PoolClient;
  await assert.rejects(assertAccountStorageQuota(client, 'multi-role-account', 1, limits), { code: 'CONTENT_UPLOAD_PENDING_LIMIT' });
});

function abandonedUploadsFixture(options: { exists?: boolean; storageUnavailable?: boolean; unexpired?: boolean;
  table?: 'storage_assets' | 'course_delivery_assets'; withinSafetyWindow?: boolean } = {}) {
  let usedBytes = 240;
  let released = 0;
  const table = options.table ?? 'storage_assets';
  const client = { query: async (sql: string) => {
    if (sql.includes('account_assets')) return { rows: [{ used_bytes: String(usedBytes), pending_uploads: '0' }] };
    if (sql.includes(`quota:expired:${table}`)) {
      assert.match(sql, /owner_user_id = \$1/);
      assert.match(sql, /verified_byte_size IS NULL/);
      assert.match(sql, /upload_expires_at <= now\(\) -/);
      assert.match(sql, /FOR UPDATE SKIP LOCKED/);
      if (table === 'course_delivery_assets') assert.match(sql, /asset_purpose = 'cloud_download'/);
      else assert.match(sql, /NOT EXISTS/);
      return { rows: options.unexpired ? [] : [{
      asset_id: 'old-failed-upload', bucket_name: 'test-bucket', object_key: 'content/failed.mp4',
      upload_expires_at: new Date(Date.now() - (options.withinSafetyWindow ? 30_000 : 61_000)),
      }] };
    }
    if (sql.includes(`quota:release:${table}`)) { usedBytes = 40; released++; }
    return { rows: [] };
  } } as unknown as PoolClient;
  const findObject = async () => {
    if (options.storageUnavailable) throw new Error('Storage network failure');
    return options.exists ? { contentLength: 200 } : null;
  };
  return { client, findObject, released: () => released };
}

test('an expired upload confirmed absent from storage no longer blocks a new upload', async () => {
  for (const table of ['storage_assets', 'course_delivery_assets'] as const) {
    const f = abandonedUploadsFixture({ table });
    await assertAccountStorageQuota(f.client, 'account', 50, limits, { findObject: f.findObject });
    assert.equal(f.released(), 1);
  }
});

test('quota recovery preserves uploaded objects, uncertain storage errors and live upload authorisations', async () => {
  for (const options of [{ exists: true }, { storageUnavailable: true }, { unexpired: true }, { withinSafetyWindow: true }]) {
    const f = abandonedUploadsFixture(options);
    await assert.rejects(assertAccountStorageQuota(f.client, 'account', 50, limits, { findObject: f.findObject }),
      { code: 'CONTENT_STORAGE_QUOTA_EXCEEDED' });
    assert.equal(f.released(), 0);
  }
});
