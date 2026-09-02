import assert from 'node:assert/strict';
import test from 'node:test';
import { storageQuotaViolation } from './storage-quota.js';

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
