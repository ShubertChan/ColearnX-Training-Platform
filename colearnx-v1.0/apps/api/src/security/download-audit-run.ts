import { Pool } from 'pg';
import { env } from '../config/env.js';
import { closeDatabase } from '../db/database.js';
import { runDownloadAudit } from './download-audit.js';
import { persistSecurityEvent, systemFingerprint } from './events.js';

/**
 * F-20 download-link audit.
 *
 *   npm --prefix apps/api run security:download-audit
 *
 * Detection only. Aggregates content.download_issued events over the window
 * (DOWNLOAD_AUDIT_WINDOW_HOURS, default 24) and records one
 * content.download_anomaly event per account+file that trips a rule. Exits
 * non-zero if any finding could not be written.
 */
function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`Expected a positive integer, got: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, got: ${value}`);
  return parsed;
}

async function main() {
  const windowHours = positiveIntFromEnv(process.env.DOWNLOAD_AUDIT_WINDOW_HOURS, 24);
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 2,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
  });
  try {
    const summary = await runDownloadAudit(pool, async (verdict, pattern) => {
      try {
        await persistSecurityEvent(systemFingerprint(), {
          type: 'content.download_anomaly',
          severity: verdict.severity,
          actorUserId: verdict.actorUserId,
          decision: 'allow',
          riskScore: verdict.riskScore,
          ruleHits: verdict.ruleHits,
          context: {
            assetId: verdict.assetId,
            assetKind: pattern.assetKind,
            issued: pattern.issued,
            networks: pattern.networks,
            reasons: verdict.reasons,
            windowHours,
          },
        });
      } catch (error) {
        process.stderr.write(
          `Failed to record download anomaly for actor ${verdict.actorUserId}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        throw error;
      }
    }, { windowHours });
    process.stdout.write(
      `Download audit: assessed ${summary.patternsAssessed} account/file pattern(s), flagged ${summary.flagged}, `
      + `${summary.recordFailures} event write(s) failed.\n`,
    );
    if (summary.recordFailures > 0) process.exitCode = 1;
  } finally {
    await pool.end();
    await closeDatabase();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
