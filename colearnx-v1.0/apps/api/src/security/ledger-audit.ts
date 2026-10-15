// W7 (threat model F-22): daily points-ledger reconciliation.
//
// point_accounts.available_balance / frozen_balance / expired_balance /
// blocked_balance are projections. The source of truth is the append-only
// point_ledger_entries table, whose per-transaction entries are forced to sum
// to zero by a database trigger (002). A projection that has drifted from the
// sum of its ledger deltas is "账本失衡无人发现": real balance corruption, or a
// write path that updated the projection without a matching ledger entry.
//
// This module only reads. It takes its pool as a parameter (like
// retention-sweep.ts) so the reconciliation arithmetic is unit-tested with a
// fake pool and imports no environment. The runner (ledger-audit-run.ts) wires
// it to a real connection and to recordSecurityEvent.

export type LedgerBalanceRow = {
  point_account_id: string;
  user_id: string | null;
  account_status: string;
  available_balance: string;
  frozen_balance: string;
  expired_balance: string;
  blocked_balance: string;
  available_sum: string;
  frozen_sum: string;
  expired_sum: string;
  blocked_sum: string;
};

export type BalanceField = 'available' | 'frozen' | 'expired' | 'blocked';
export type BalanceDiscrepancy = { field: BalanceField; projected: number; ledger: number; delta: number };

// Points are stored as bigint and arrive as text so JavaScript never rounds a
// balance larger than 2^53. A value that genuinely exceeds the safe range is
// surfaced as an error rather than silently compared after a lossy parse.
function toSafeInt(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is not a safe integer: ${value}`);
  return parsed;
}

/** Pure: compares each projected balance against the summed ledger deltas. */
export function diffAccountBalances(row: LedgerBalanceRow): BalanceDiscrepancy[] {
  const fields: Array<{ field: BalanceField; projected: string; ledger: string }> = [
    { field: 'available', projected: row.available_balance, ledger: row.available_sum },
    { field: 'frozen', projected: row.frozen_balance, ledger: row.frozen_sum },
    { field: 'expired', projected: row.expired_balance, ledger: row.expired_sum },
    { field: 'blocked', projected: row.blocked_balance, ledger: row.blocked_sum },
  ];
  const discrepancies: BalanceDiscrepancy[] = [];
  for (const entry of fields) {
    const projected = toSafeInt(entry.projected, `${entry.field} projected balance`);
    const ledger = toSafeInt(entry.ledger, `${entry.field} ledger sum`);
    if (projected !== ledger) discrepancies.push({ field: entry.field, projected, ledger, delta: projected - ledger });
  }
  return discrepancies;
}

// The projection and the ledger must be read from one instant, or an in-flight
// posting that has updated the projection but not yet committed its entry (or
// vice versa) would be reported as a false imbalance. A read-only repeatable-
// read snapshot gives both reads the same moment.
export const LEDGER_AUDIT_QUERY = `
  SELECT pa.point_account_id, pa.user_id, pa.account_status,
         pa.available_balance::text, pa.frozen_balance::text,
         pa.expired_balance::text, pa.blocked_balance::text,
         COALESCE(SUM(le.available_delta), 0)::text AS available_sum,
         COALESCE(SUM(le.frozen_delta), 0)::text   AS frozen_sum,
         COALESCE(SUM(le.expired_delta), 0)::text  AS expired_sum,
         COALESCE(SUM(le.blocked_delta), 0)::text  AS blocked_sum
    FROM point_accounts pa
    LEFT JOIN point_ledger_entries le ON le.point_account_id = pa.point_account_id
   GROUP BY pa.point_account_id`;

type AuditClient = {
  query(sql: string, parameters?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(): void;
};
export type LedgerAuditPool = { connect(): Promise<AuditClient> };

export type LedgerImbalance = {
  pointAccountId: string;
  actorUserId: string | null;
  accountStatus: string;
  discrepancies: BalanceDiscrepancy[];
};
export type LedgerAuditEmit = (imbalance: LedgerImbalance) => Promise<void>;

export type LedgerAuditSummary = { accountsChecked: number; imbalancedAccounts: number };

export async function auditLedgerBalances(pool: LedgerAuditPool, emit: LedgerAuditEmit): Promise<LedgerAuditSummary> {
  const client = await pool.connect();
  let snapshotOpen = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    snapshotOpen = true;
    const result = await client.query(LEDGER_AUDIT_QUERY);
    await client.query('COMMIT');
    snapshotOpen = false;
    const rows = result.rows as LedgerBalanceRow[];
    let imbalancedAccounts = 0;
    // Emit after the snapshot is closed: recordSecurityEvent writes on a
    // different connection and must not run inside this read-only transaction.
    for (const row of rows) {
      const discrepancies = diffAccountBalances(row);
      if (discrepancies.length > 0) {
        imbalancedAccounts += 1;
        await emit({
          pointAccountId: row.point_account_id,
          actorUserId: row.user_id,
          accountStatus: row.account_status,
          discrepancies,
        });
      }
    }
    return { accountsChecked: rows.length, imbalancedAccounts };
  } catch (error) {
    if (snapshotOpen) {
      try { await client.query('ROLLBACK'); } catch { /* the snapshot is already gone */ }
    }
    throw error;
  } finally {
    client.release();
  }
}
