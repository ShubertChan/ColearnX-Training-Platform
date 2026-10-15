import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeActorAggregates,
  RAPID_REFUND_SQL,
  REFUND_VELOCITY_SQL,
  runRiskSweep,
  SELF_PURCHASE_SQL,
} from './risk-sweep.js';

test('aggregates merge per actor and default missing signals to zero', () => {
  const merged = mergeActorAggregates(
    [{ actor: 'a', n: '4' }, { actor: 'b', n: '1' }],
    [{ actor: 'b', n: '2' }],
    [{ actor: 'a', n: '3' }],
  );
  const byId = new Map(merged.map((m) => [m.actorUserId, m]));
  assert.deepEqual(byId.get('a'), { actorUserId: 'a', refundCount: 4, selfPurchaseCount: 0, rapidRefundCount: 3 });
  assert.deepEqual(byId.get('b'), { actorUserId: 'b', refundCount: 1, selfPurchaseCount: 2, rapidRefundCount: 0 });
});

test('a malformed aggregate count is rejected rather than scored', () => {
  assert.throws(() => mergeActorAggregates([{ actor: 'a', n: '-1' }], [], []), /non-negative safe integer/);
});

function fakePool(results: { refunds: unknown[]; selfPurchases: unknown[]; rapidRefunds: unknown[] }) {
  const windowParams: unknown[][] = [];
  return {
    async connect() {
      return {
        async query(sql: string, parameters?: unknown[]) {
          if (sql === REFUND_VELOCITY_SQL) { windowParams.push(parameters ?? []); return { rows: results.refunds, rowCount: results.refunds.length }; }
          if (sql === SELF_PURCHASE_SQL) { return { rows: results.selfPurchases, rowCount: results.selfPurchases.length }; }
          if (sql === RAPID_REFUND_SQL) { windowParams.push(parameters ?? []); return { rows: results.rapidRefunds, rowCount: results.rapidRefunds.length }; }
          throw new Error(`unexpected sql: ${sql}`);
        },
        release() {},
      };
    },
    windowParams,
  };
}

test('the sweep flags only actors that trip a rule and passes window parameters through', async () => {
  const pool = fakePool({
    refunds: [{ actor: 'clean', n: '1' }, { actor: 'abuser', n: '5' }],
    selfPurchases: [{ actor: 'dealer', n: '1' }],
    rapidRefunds: [],
  });
  const flagged: Array<{ actor: string; score: number; hits: string[] }> = [];
  const summary = await runRiskSweep(pool, async (verdict) => {
    flagged.push({ actor: verdict.actorUserId, score: verdict.riskScore, hits: verdict.ruleHits });
  }, { windowDays: 14 });

  assert.equal(summary.actorsAssessed, 3); // clean, abuser, dealer
  assert.equal(summary.actorsFlagged, 2);  // abuser (refund velocity) + dealer (self purchase)
  const byActor = new Map(flagged.map((f) => [f.actor, f]));
  assert.ok(!byActor.has('clean'));
  assert.deepEqual(byActor.get('abuser')?.hits, ['refund_velocity']);
  assert.deepEqual(byActor.get('dealer')?.hits, ['self_purchase']);
  assert.deepEqual(pool.windowParams[0], [14]);
});
