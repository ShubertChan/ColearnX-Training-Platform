import type { SecurityEventInput } from './events.js';
import type { LedgerImbalance } from './ledger-audit.js';
import type { ActorRiskInput, ActorRiskVerdict } from './fraud-rules.js';

export function ledgerEvent({ pointAccountId, actorUserId, accountStatus, discrepancies }: LedgerImbalance): SecurityEventInput {
  return { type: 'finance.ledger_imbalance', actorUserId, decision: 'allow', context: { pointAccountId, accountStatus, discrepancies } };
}

export function riskEvent(verdict: ActorRiskVerdict, counts: ActorRiskInput): SecurityEventInput {
  return {
    type: 'finance.risk_flagged', severity: verdict.severity, actorUserId: verdict.actorUserId,
    decision: 'allow', riskScore: verdict.riskScore, ruleHits: verdict.ruleHits,
    context: {
      reasons: verdict.reasons, refundCount: counts.refundCount, selfPurchaseCount: counts.selfPurchaseCount,
      rapidRefundCount: counts.rapidRefundCount, purchasedItems: counts.purchasedItems, refundedItems: counts.refundedItems,
    },
  };
}
