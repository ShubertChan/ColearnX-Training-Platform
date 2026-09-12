import assert from 'node:assert/strict';
import test from 'node:test';
import { purchaseRefundPolicyPreview, refundPolicySnapshot } from './purchase-policy.js';
import { evaluateRefund } from './policy.js';

test('content disclosure and purchase snapshot share the actual no-download policy', () => {
  const preview = purchaseRefundPolicyPreview('content');
  const snapshot = refundPolicySnapshot({ kind: 'content', deliveryModes: [], startsAt: null, totalDurationSeconds: null }, new Date('2026-09-12T00:00:00Z'));
  assert.ok(preview.summary.length > 0);
  for (const [key, value] of Object.entries(preview)) assert.deepEqual(snapshot[key as keyof typeof snapshot], value);
  assert.equal(evaluateRefund({ policySnapshot: snapshot, requestTime: new Date(), downloadCompletedAt: new Date() }).eligible, false);
  assert.equal(evaluateRefund({ policySnapshot: snapshot, requestTime: new Date() }).eligible, true);
});

test('course policies keep self-arranged and recorded-video rules unchanged', () => {
  for (const deliveryModes of [['cloud'], ['record'], ['local'], ['live'], ['record', 'live']]) {
    const input = { kind: 'course' as const, deliveryModes, startsAt: new Date('2026-10-01T00:00:00Z'), totalDurationSeconds: 600 };
    const preview = purchaseRefundPolicyPreview(input.kind, deliveryModes);
    const snapshot = refundPolicySnapshot(input, new Date('2026-09-12T00:00:00Z'));
    assert.equal(snapshot.rule, preview.rule);
    assert.equal(snapshot.summary, preview.summary);
    assert.equal(preview.rule, deliveryModes.some((mode) => ['local', 'live'].includes(mode)) ? 'self-arranged-72h-v1' : 'recorded-media-10pct-no-download-v1');
  }
});
