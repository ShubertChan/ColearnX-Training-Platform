import { Pool } from 'pg';
import { env } from '../config/env.js';
import { closeDatabase } from '../db/database.js';
import { recordSecurityEvent, systemFingerprint } from './events.js';
import { auditLedgerBalances } from './ledger-audit.js';

/**
 * F-22 reconciliation job.
 *
 *   npm --prefix apps/api run security:ledger-audit
 *
 * Reads every point account against the summed ledger deltas on a read-only
 * snapshot and records one finance.ledger_imbalance security event per
 * account whose projection has drifted. Read-only: it runs as the ordinary
 * runtime role, which has SELECT on the ledger and INSERT on security_events.
 */
async function main() {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 2,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
  });
  try {
    const summary = await auditLedgerBalances(pool, async ({ pointAccountId, actorUserId, accountStatus, discrepancies }) => {
      await recordSecurityEvent(systemFingerprint(), {
        type: 'finance.ledger_imbalance',
        actorUserId,
        decision: 'allow',
        context: { pointAccountId, accountStatus, discrepancies },
      });
    });
    process.stdout.write(
      `Ledger audit: checked ${summary.accountsChecked} point accounts, ${summary.imbalancedAccounts} imbalanced.\n`,
    );
  } finally {
    await pool.end();
    await closeDatabase();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
