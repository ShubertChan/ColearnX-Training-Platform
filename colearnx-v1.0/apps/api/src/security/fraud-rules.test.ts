import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RAPID_REFUND_THRESHOLD,
  REFUND_VELOCITY_THRESHOLD,
  scoreActor,
  type ActorRiskInput,
} from './fraud-rules.js';

const clean: ActorRiskInput = { actorUserId: 'u1', refundCount: 0, selfPurchaseCount: 0, rapidRefundCount: 0 };

test('an actor that trips no rule produces no verdict', () => {
  assert.equal(scoreActor(clean), null);
  // Just under each threshold still fires nothing.
  assert.equal(scoreActor({ ...clean, refundCount: REFUND_VELOCITY_THRESHOLD - 1, rapidRefundCount: RAPID_REFUND_THRESHOLD - 1 }), null);
});

test('self-purchase alone is high severity', () => {
  const verdict = scoreActor({ ...clean, selfPurchaseCount: 1 });
  assert.ok(verdict);
  assert.deepEqual(verdict.ruleHits, ['self_purchase']);
  assert.equal(verdict.riskScore, 60);
  assert.equal(verdict.severity, 3);
});

test('refund velocity alone is medium severity', () => {
  const verdict = scoreActor({ ...clean, refundCount: REFUND_VELOCITY_THRESHOLD });
  assert.ok(verdict);
  assert.deepEqual(verdict.ruleHits, ['refund_velocity']);
  assert.equal(verdict.riskScore, 40);
  assert.equal(verdict.severity, 2);
});

test('rapid refunds alone are low severity', () => {
  const verdict = scoreActor({ ...clean, rapidRefundCount: RAPID_REFUND_THRESHOLD });
  assert.ok(verdict);
  assert.deepEqual(verdict.ruleHits, ['rapid_refund']);
  assert.equal(verdict.riskScore, 20);
  assert.equal(verdict.severity, 1);
});

test('multiple signals stack and the score is capped at 100', () => {
  const verdict = scoreActor({ actorUserId: 'u1', refundCount: 9, selfPurchaseCount: 2, rapidRefundCount: 5 });
  assert.ok(verdict);
  // 60 + 40 + 30 = 130, capped at 100.
  assert.equal(verdict.riskScore, 100);
  assert.equal(verdict.severity, 3);
  assert.deepEqual(verdict.ruleHits, ['self_purchase', 'refund_velocity', 'rapid_refund']);
  assert.equal(verdict.reasons.length, 3);
});
