import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRefund } from './policy.js';

const purchasedAt = new Date('2026-01-01T00:00:00.000Z');
test('hosted refund includes exactly 72 hours and 10 percent', () => {
  const result = evaluateRefund({ deliveryModes: ['cloud'], purchasedAt, requestTime: new Date('2026-01-04T00:00:00.000Z'), progressPercent: 10 });
  assert.equal(result.eligible, true);
});
test('hosted refund rejects more than 10 percent progress', () => {
  const result = evaluateRefund({ deliveryModes: ['cloud'], purchasedAt, requestTime: new Date('2026-01-02T00:00:00.000Z'), progressPercent: 10.01 });
  assert.equal(result.code, 'HOSTED_PROGRESS_EXCEEDED');
});
test('live refund includes exactly 72 hours before start', () => {
  const result = evaluateRefund({ deliveryModes: ['live', 'record'], purchasedAt, requestTime: new Date('2026-01-03T00:00:00.000Z'), startsAt: new Date('2026-01-06T00:00:00.000Z') });
  assert.equal(result.eligible, true);
});
test('local is never refundable in V1', () => {
  const result = evaluateRefund({ deliveryModes: ['cloud', 'local'], purchasedAt, requestTime: purchasedAt, progressPercent: 0 });
  assert.equal(result.code, 'LOCAL_NON_REFUNDABLE');
});
