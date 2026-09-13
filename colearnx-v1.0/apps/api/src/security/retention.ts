import { Pool } from 'pg';
import { loadMigrationEnv } from '../config/migration-env.js';
import { parseRetentionDays, runSecurityRetention } from './retention-sweep.js';

/**
 * Retention sweep for the security ledger.
 *
 * Runs under the owner connection used for migrations, not the runtime one.
 * That is the point: 009 grants colearnx_app only SELECT and INSERT, so an
 * attacker who reaches the API credential cannot delete the evidence of doing
 * so. Deletion is a separate, deliberately operated capability.
 *
 * A retention period is a security control in both directions. Too short and
 * an intrusion discovered late cannot be investigated; too long and the
 * ledger becomes a standing collection of behavioural data about users, which
 * is the harm PDPA's retention limitation principle addresses. 180 days is the
 * default because it comfortably exceeds typical time-to-detection while still
 * being a bounded window.
 *
 * Closed reset challenges requested more than 30 days ago are swept here too.
 * Both cleanup operations commit together or leave all records intact.
 *
 *   npm --prefix apps/api run security:retention
 */
async function main() {
  const retentionDays = parseRetentionDays(process.env.SECURITY_EVENT_RETENTION_DAYS);
  const migrationEnv = loadMigrationEnv();
  const pool = new Pool({
    connectionString: migrationEnv.MIGRATION_DATABASE_URL,
    ssl: migrationEnv.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
  });
  try {
    const { eventsRemoved, tokensRemoved } = await runSecurityRetention(pool, retentionDays);
    process.stdout.write(
      `Retention sweep: removed ${eventsRemoved} security events older than ${retentionDays} days, `
      + `${tokensRemoved} closed reset tokens.\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
