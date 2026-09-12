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
