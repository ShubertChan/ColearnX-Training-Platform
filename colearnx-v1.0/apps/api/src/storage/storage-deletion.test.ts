import assert from 'node:assert/strict';
import test from 'node:test';
import { canFinalizeStorageAssetDeletion, remainingSignedUploadTtlSeconds } from './storage-deletion.js';

test('limits a replayed upload TTL to the database intent remainder', () => {
  const now = new Date('2026-09-04T12:00:00.000Z');
  assert.equal(remainingSignedUploadTtlSeconds('2026-09-04T12:00:09.999Z', now), 9);
  assert.equal(remainingSignedUploadTtlSeconds('2026-09-04T12:00:00.999Z', now), 0);
  assert.equal(remainingSignedUploadTtlSeconds('2026-09-04T11:59:59.000Z', now), 0);
  assert.equal(remainingSignedUploadTtlSeconds('not-a-date', now), 0);
});

test('waits for the signed upload expiry safety window before final deletion', () => {
  const now = new Date('2026-09-04T12:00:00.000Z');
  assert.equal(canFinalizeStorageAssetDeletion('2026-09-04T11:58:59.000Z', now), true);
  assert.equal(canFinalizeStorageAssetDeletion('2026-09-04T11:59:01.000Z', now), false);
  assert.equal(canFinalizeStorageAssetDeletion('2026-09-04T12:05:00.000Z', now), false);
  assert.equal(canFinalizeStorageAssetDeletion('not-a-date', now), false);
});
