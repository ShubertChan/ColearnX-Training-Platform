import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRefund } from './policy.js';

const selfArranged = { rule: 'self-arranged-72h-v1', startsAt: '2026-01-06T00:00:00.000Z' };

test('self-arranged refund includes exactly 72 hours before course start', () => {
  const result = evaluateRefund({ policySnapshot: selfArranged, requestTime: new Date('2026-01-03T00:00:00.000Z') });
  assert.equal(result.eligible, true);
});
test('self-arranged refund rejects after the 72-hour notice boundary', () => {
  const result = evaluateRefund({ policySnapshot: selfArranged, requestTime: new Date('2026-01-03T00:00:00.001Z') });
  assert.equal(result.code, 'SELF_ARRANGED_NOTICE_EXPIRED');
});
test('recorded media allows exactly 10 percent with no download', () => {
  const result = evaluateRefund({ policySnapshot: { rule: 'recorded-media-10pct-no-download-v1', watchedRatioMaximum: 0.1 }, requestTime: new Date(), watchedSeconds: 10, totalDurationSeconds: 100 });
  assert.equal(result.eligible, true);
});
test('recorded media rejects any protected file download', () => {
  const result = evaluateRefund({ policySnapshot: { rule: 'recorded-media-10pct-no-download-v1' }, requestTime: new Date(), downloadCompletedAt: new Date() });
  assert.equal(result.code, 'RECORDED_MEDIA_DOWNLOADED');
});
test('recorded media rejects more than 10 percent viewing', () => {
  const result = evaluateRefund({ policySnapshot: { rule: 'recorded-media-10pct-no-download-v1' }, requestTime: new Date(), watchedSeconds: 10.01, totalDurationSeconds: 100 });
  assert.equal(result.code, 'RECORDED_MEDIA_PROGRESS_EXCEEDED');
});

test('historical orders retain their original snapshot rule', () => {
  const result = evaluateRefund({ policySnapshot: { rule: 'hosted-72h-progress-10', purchasedAt: '2026-01-01T00:00:00.000Z' }, requestTime: new Date('2026-01-04T00:00:00.001Z'), progressPercent: 0 });
  assert.equal(result.code, 'HOSTED_WINDOW_EXPIRED');
});
