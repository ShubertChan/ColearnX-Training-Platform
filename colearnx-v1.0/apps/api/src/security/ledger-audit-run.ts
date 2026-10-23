import { Pool } from 'pg';
import { env } from '../config/env.js';
import { closeDatabase } from '../db/database.js';
import { closeRedis } from '../lib/redis.js';
import { drainSecurityAlerts, persistSecurityEvent, systemFingerprint } from './events.js';
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
      try {
        await persistSecurityEvent(systemFingerprint(), {
          type: 'finance.ledger_imbalance',
          actorUserId,
          decision: 'allow',
          context: { pointAccountId, accountStatus, discrepancies },
        });
      } catch (error) {
        // Make the lost finding loud, then rethrow so the job counts it.
        process.stderr.write(
          `Failed to record ledger imbalance for account ${pointAccountId}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        throw error;
      }
    });
    process.stdout.write(
      `Ledger audit: checked ${summary.accountsChecked} point accounts, ${summary.imbalancedAccounts} imbalanced, `
      + `${summary.recordFailures} event write(s) failed.\n`,
    );
    // A detected imbalance whose event could not be written is a failure of the
    // job's whole purpose: exit non-zero so the scheduler does not treat it as a
    // clean run.
    if (summary.recordFailures > 0) process.exitCode = 1;
  } finally {
    // Let any alert raised by a finding finish, then close Redis: its socket
    // would otherwise keep the process alive and the scheduler would never see
    // this job's exit code.
    await drainSecurityAlerts();
    await closeRedis();
    await pool.end();
    await closeDatabase();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
