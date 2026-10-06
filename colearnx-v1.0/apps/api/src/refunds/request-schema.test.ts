import assert from 'node:assert/strict';
import test from 'node:test';
import { refundRequestSchema } from './request-schema.js';

const orderItemId = 'cf8d2055-8ba7-409a-baae-cf0b679618b4';

test('refund reasons accepted by the form also pass server validation', () => {
  for (const reason of ['不想学', '不想学了', 'abc', 'abcd', 'a'.repeat(2000)]) {
    assert.equal(refundRequestSchema.parse({ orderItemId, reason }).reason, reason);
  }
  assert.equal(refundRequestSchema.parse({ orderItemId, reason: '  不想学  ' }).reason, '不想学');
});

test('refund requests reject whitespace-only reasons, excessive text and invalid purchase IDs', () => {
  for (const reason of ['', '   ', ' a ', 'ab', 'a'.repeat(2001)]) {
    assert.equal(refundRequestSchema.safeParse({ orderItemId, reason }).success, false);
  }
  assert.equal(refundRequestSchema.safeParse({ orderItemId: 'missing', reason: 'Valid reason' }).success, false);
});
