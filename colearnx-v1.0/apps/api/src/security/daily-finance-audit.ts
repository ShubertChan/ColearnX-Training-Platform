import { env } from '../config/env.js';
import { withTransaction } from '../db/database.js';
import { insertSecurityEvent, notifySecurityEvent, systemFingerprint, type SecurityEventInput } from './events.js';
import { ledgerEvent, riskEvent } from './finance-events.js';
import { assessLedgerRows, LEDGER_AUDIT_QUERY, UNBALANCED_TRANSACTIONS_QUERY, type LedgerBalanceRow } from './ledger-audit.js';
import { sweepWithClient } from './risk-sweep.js';

export async function runDailyFinanceAudit(now = new Date()) {
  if (now.getUTCHours() * 60 + now.getUTCMinutes() < 135) return 'not-due';
  const auditDate = now.toISOString().slice(0, 10);
  const fingerprint = systemFingerprint();
  const alerts: SecurityEventInput[] = [];
  const status = await withTransaction(async client => {
    // One atomic batch on one restricted connection, even on a one-connection
    // pool. A crash rolls back both the findings and the completion marker.
    const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('colearnx:daily-finance',0)) AS held");
    if (!lock.rows[0].held) return 'busy';
    const prior = await client.query(`SELECT 1 FROM security_events WHERE event_type='finance.daily_audit_completed'
      AND context_json->>'auditDate'=$1 LIMIT 1`, [auditDate]);
    if (prior.rowCount) return 'already-complete';
    const emit = async (event: SecurityEventInput) => {
      await insertSecurityEvent(fingerprint, event, (sql, args) => client.query(sql, args));
      alerts.push(event);
    };
    const balances = await client.query<LedgerBalanceRow>(LEDGER_AUDIT_QUERY);
    const ledger = await assessLedgerRows(balances.rows, finding => emit(ledgerEvent(finding)));
    const transactions = await client.query<{point_transaction_id: string; net: string}>(UNBALANCED_TRANSACTIONS_QUERY);
    for (const row of transactions.rows) {
      await emit({ type: 'finance.ledger_imbalance', decision: 'allow',
        context: { pointTransactionId: row.point_transaction_id, netDelta: row.net } });
    }
    const risk = await sweepWithClient(client, (verdict, counts) => emit(riskEvent(verdict, counts)), {
      windowDays: env.FINANCE_RISK_WINDOW_DAYS, rapidRefundSeconds: env.FINANCE_RAPID_REFUND_SECONDS,
    });
    if (ledger.recordFailures || risk.recordFailures) throw new Error('Failed to persist daily finance findings.');
    await insertSecurityEvent(fingerprint, { type: 'finance.daily_audit_completed', decision: 'allow',
      context: { auditDate, accountsChecked: ledger.accountsChecked, imbalances: ledger.imbalancedAccounts,
        unbalancedTransactions: transactions.rows.length, actorsFlagged: risk.actorsFlagged },
    }, (sql, args) => client.query(sql, args));
    return 'completed';
  });
  if (status === 'completed') for (const event of alerts) notifySecurityEvent(fingerprint, event);
  return status;
}

export function startDailyFinanceAudit() {
  let pending: Promise<void> | undefined;
  const tick = () => {
    if (pending) return;
    pending = runDailyFinanceAudit()
      .catch((error: Error) => { process.stderr.write(`Daily finance audit will retry: ${error.message}\n`); })
      .then(() => { pending = undefined; });
  };
  const timer = setInterval(tick, 15 * 60_000);
  timer.unref();
  tick();
  return async () => { clearInterval(timer); await pending; };
}
