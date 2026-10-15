// W7 (threat model F-21): the fund-side rule engine.
//
// "无退款滥用、创作者自购刷单、积分套现的任何检测." These are the three pure
// rules. Each takes a per-actor aggregate computed over a recent window and
// decides whether it fired; the engine sums the weights of the fired rules
// into a 0-100 risk score and a severity. It is deliberately pure: no database,
// no clock, no environment, so the thresholds and the scoring are unit-tested
// exhaustively. risk-sweep.ts gathers the aggregates and feeds them here; the
// score and rule hits are written onto a security_events row using the
// risk_score / rule_hits columns reserved for this engine in migration 009.

export type ActorRiskInput = {
  actorUserId: string;
  // Refund requests this actor filed in the window.
  refundCount: number;
  // Orders in the window where the actor bought an item they are also the
  // seller of (creator/trainer self-purchase -- wash trading / earnings
  // laundering).
  selfPurchaseCount: number;
  // Refund requests this actor filed within a few minutes of the purchase
  // (buy-then-immediately-refund churn).
  rapidRefundCount: number;
};

export type FraudRule = {
  key: string;
  weight: number;
  fires: (input: ActorRiskInput) => boolean;
  describe: (input: ActorRiskInput) => string;
};

// Thresholds are exported so the tests and the sweep share one definition.
export const REFUND_VELOCITY_THRESHOLD = 3;
export const RAPID_REFUND_THRESHOLD = 2;

// Self-dealing is weighted highest: a single confirmed self-purchase is a
// deliberate act, whereas a few refunds can be legitimate. Order matters only
// for readability; scoring is order-independent.
export const FRAUD_RULES: readonly FraudRule[] = [
  {
    key: 'self_purchase',
    weight: 60,
    fires: (input) => input.selfPurchaseCount >= 1,
    describe: (input) => `bought own listing ${input.selfPurchaseCount} time(s)`,
  },
  {
    key: 'refund_velocity',
    weight: 40,
    fires: (input) => input.refundCount >= REFUND_VELOCITY_THRESHOLD,
    describe: (input) => `${input.refundCount} refund requests in window`,
  },
  {
    // Kept below the medium cut (30) so a buy-then-refund pattern on its own is
    // low severity -- mildly suspicious, not worth paging -- while still adding
    // weight when it co-occurs with another signal.
    key: 'rapid_refund',
    weight: 20,
    fires: (input) => input.rapidRefundCount >= RAPID_REFUND_THRESHOLD,
    describe: (input) => `${input.rapidRefundCount} refunds shortly after purchase`,
  },
];

export type RiskSeverity = 0 | 1 | 2 | 3 | 4;

export type ActorRiskVerdict = {
  actorUserId: string;
  riskScore: number;
  ruleHits: string[];
  severity: RiskSeverity;
  reasons: string[];
};

/**
 * Returns a verdict when at least one rule fires, otherwise null (nothing to
 * record). The score is capped at 100 to fit the migration-009 column, and the
 * severity ladder decides whether the event pages an operator: >= 60 is high
 * (self-dealing, or several signals at once), 30-59 medium, below that low.
 */
export function scoreActor(input: ActorRiskInput): ActorRiskVerdict | null {
  const fired = FRAUD_RULES.filter((rule) => rule.fires(input));
  if (fired.length === 0) return null;
  const rawScore = fired.reduce((total: number, rule) => total + rule.weight, 0);
  const riskScore = Math.min(100, rawScore);
  const severity: RiskSeverity = riskScore >= 60 ? 3 : riskScore >= 30 ? 2 : 1;
  return {
    actorUserId: input.actorUserId,
    riskScore,
    ruleHits: fired.map((rule) => rule.key),
    severity,
    reasons: fired.map((rule) => rule.describe(input)),
  };
}
