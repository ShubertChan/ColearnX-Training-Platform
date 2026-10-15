// W7 (threat model F-21): the batch risk sweep.
//
// Detection, not enforcement: the sweep never blocks a live purchase or refund.
// It reads recent fund activity, runs the pure rule engine in fraud-rules.ts,
// and records a finance.risk_flagged security event (carrying risk_score and
// rule_hits, the columns migration 009 reserved for exactly this) for every
// actor that trips a rule. Those events surface in the W6 security monitor.
//
// Like ledger-audit.ts and retention-sweep.ts it takes its pool and its emit
// callback as parameters, so the aggregation-to-verdict path is unit-tested
// with a fake pool and imports no environment.

import { scoreActor, type ActorRiskInput, type ActorRiskVerdict } from './fraud-rules.js';

export const DEFAULT_WINDOW_DAYS = 30;
// "Shortly after purchase" for the rapid-refund signal.
export const DEFAULT_RAPID_REFUND_SECONDS = 300;

type SweepClient = {
  query(sql: string, parameters?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(): void;
};
export type RiskSweepPool = { connect(): Promise<SweepClient> };

export type RiskSweepEmit = (verdict: ActorRiskVerdict, counts: ActorRiskInput) => Promise<void>;

export type RiskSweepOptions = { windowDays?: number; rapidRefundSeconds?: number };
// recordFailures counts flagged actors whose security event could NOT be
// written, so the job never reports success while a flag was lost; the runner
// exits non-zero on any failure.
export type RiskSweepSummary = { actorsAssessed: number; actorsFlagged: number; recordFailures: number };

type ActorCountRow = { actor: string; n: string };

// Refund requests per actor in the window.
export const REFUND_VELOCITY_SQL = `
  SELECT requested_by_user_id::text AS actor, count(*)::text AS n
    FROM refund_requests
   WHERE requested_at > now() - ($1 * interval '1 day')
   GROUP BY requested_by_user_id`;

// Orders in the window where the buyer is also the item's seller.
export const SELF_PURCHASE_SQL = `
  SELECT o.buyer_user_id::text AS actor, count(*)::text AS n
    FROM order_items oi
    JOIN orders o ON o.order_id = oi.order_id
   WHERE oi.seller_user_id = o.buyer_user_id
     AND o.created_at > now() - ($1 * interval '1 day')
   GROUP BY o.buyer_user_id`;

// Refund requests filed within $2 seconds of the order being created.
export const RAPID_REFUND_SQL = `
  SELECT rr.requested_by_user_id::text AS actor, count(*)::text AS n
    FROM refund_requests rr
    JOIN order_items oi ON oi.order_item_id = rr.order_item_id
    JOIN orders o ON o.order_id = oi.order_id
   WHERE rr.requested_at > now() - ($1 * interval '1 day')
     AND rr.requested_at - o.created_at < ($2 * interval '1 second')
   GROUP BY rr.requested_by_user_id`;

function toCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Aggregate count is not a non-negative safe integer: ${value}`);
  return parsed;
}

/**
 * Pure: folds the three per-actor aggregate result sets into one record per
 * actor, defaulting any signal the actor did not appear in to zero.
 */
export function mergeActorAggregates(
  refunds: ActorCountRow[],
  selfPurchases: ActorCountRow[],
  rapidRefunds: ActorCountRow[],
): ActorRiskInput[] {
  const byActor = new Map<string, ActorRiskInput>();
  const ensure = (actor: string): ActorRiskInput => {
    let record = byActor.get(actor);
    if (!record) {
      record = { actorUserId: actor, refundCount: 0, selfPurchaseCount: 0, rapidRefundCount: 0 };
      byActor.set(actor, record);
    }
    return record;
  };
  for (const row of refunds) ensure(row.actor).refundCount = toCount(row.n);
  for (const row of selfPurchases) ensure(row.actor).selfPurchaseCount = toCount(row.n);
  for (const row of rapidRefunds) ensure(row.actor).rapidRefundCount = toCount(row.n);
  return [...byActor.values()];
}

export async function runRiskSweep(pool: RiskSweepPool, emit: RiskSweepEmit, options: RiskSweepOptions = {}): Promise<RiskSweepSummary> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const rapidRefundSeconds = options.rapidRefundSeconds ?? DEFAULT_RAPID_REFUND_SECONDS;
  const client = await pool.connect();
  try {
    const refunds = (await client.query(REFUND_VELOCITY_SQL, [windowDays])).rows as ActorCountRow[];
    const selfPurchases = (await client.query(SELF_PURCHASE_SQL, [windowDays])).rows as ActorCountRow[];
    const rapidRefunds = (await client.query(RAPID_REFUND_SQL, [windowDays, rapidRefundSeconds])).rows as ActorCountRow[];
    const actors = mergeActorAggregates(refunds, selfPurchases, rapidRefunds);
    let actorsFlagged = 0;
    let recordFailures = 0;
    for (const actor of actors) {
      const verdict = scoreActor(actor);
      if (!verdict) continue;
      actorsFlagged += 1;
      try {
        await emit(verdict, actor);
      } catch {
        // The write failed; keep assessing the rest and report the loss. The
        // emit callback is responsible for logging the specific error.
        recordFailures += 1;
      }
    }
    return { actorsAssessed: actors.length, actorsFlagged, recordFailures };
  } finally {
    client.release();
  }
}
