import { Pool } from 'pg';
import { loadMigrationEnv } from '../config/migration-env.js';

/**
 * Retention sweep for the security ledger.
 *
 * Runs under the owner connection used for migrations, not the runtime one.
 * That is the point: 008 grants colearnx_app only SELECT and INSERT, so an
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
 * Expired reset tokens are swept here too: once consumed or expired they have
 * no purpose, and the requesting IP fingerprint they carry should not outlive
 * it.
 *
 *   npm --prefix apps/api run security:retention
 */
const migrationEnv = loadMigrationEnv();
const retentionDays = Number.parseInt(process.env.SECURITY_EVENT_RETENTION_DAYS ?? '180', 10);

const pool = new Pool({
  connectionString: migrationEnv.MIGRATION_DATABASE_URL,
  ssl: migrationEnv.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
});

async function main() {
  if (!Number.isInteger(retentionDays) || retentionDays < 30 || retentionDays > 730) {
    throw new Error('SECURITY_EVENT_RETENTION_DAYS must be an integer between 30 and 730.');
  }

  const events = await pool.query(
    `DELETE FROM security_events WHERE occurred_at < now() - ($1 || ' days')::interval`,
    [retentionDays],
  );
  const tokens = await pool.query(
    `DELETE FROM password_reset_tokens
      WHERE (consumed_at IS NOT NULL OR invalidated_at IS NOT NULL OR expires_at < now())
        AND created_at < now() - interval '30 days'`,
  );

  process.stdout.write(
    `Retention sweep: removed ${events.rowCount ?? 0} security events older than ${retentionDays} days, `
    + `${tokens.rowCount ?? 0} closed reset tokens.\n`,
  );
}

main().then(() => pool.end()).catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  await pool.end();
  process.exitCode = 1;
});
