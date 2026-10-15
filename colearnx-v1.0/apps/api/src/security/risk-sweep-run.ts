import { Pool } from 'pg';
import { env } from '../config/env.js';
import { closeDatabase } from '../db/database.js';
import { persistSecurityEvent, systemFingerprint } from './events.js';
import { runRiskSweep } from './risk-sweep.js';

/**
 * F-21 fund-side risk sweep.
 *
 *   npm --prefix apps/api run security:risk-sweep
 *
 * Detection only: it never blocks a live purchase or refund. It records a
 * finance.risk_flagged security event (with risk_score / rule_hits) for every
 * actor that trips a rule, which the W6 security monitor then surfaces.
 *
 * The window and the rapid-refund threshold can be tuned with
 * FINANCE_RISK_WINDOW_DAYS and FINANCE_RAPID_REFUND_SECONDS; both default
 * sensibly and are validated as positive integers before any query runs.
 */
function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`Expected a positive integer, got: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, got: ${value}`);
  return parsed;
}

async function main() {
  const windowDays = positiveIntFromEnv(process.env.FINANCE_RISK_WINDOW_DAYS, 30);
  const rapidRefundSeconds = positiveIntFromEnv(process.env.FINANCE_RAPID_REFUND_SECONDS, 300);
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 2,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
  });
  try {
    const summary = await runRiskSweep(pool, async (verdict, counts) => {
      try {
        await persistSecurityEvent(systemFingerprint(), {
          type: 'finance.risk_flagged',
          severity: verdict.severity,
          actorUserId: verdict.actorUserId,
          decision: 'allow',
          riskScore: verdict.riskScore,
          ruleHits: verdict.ruleHits,
          context: {
            reasons: verdict.reasons,
            refundCount: counts.refundCount,
            selfPurchaseCount: counts.selfPurchaseCount,
            rapidRefundCount: counts.rapidRefundCount,
          },
        });
      } catch (error) {
        // Make the lost flag loud, then rethrow so the job counts it.
        process.stderr.write(
          `Failed to record risk flag for actor ${verdict.actorUserId}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        throw error;
      }
    }, { windowDays, rapidRefundSeconds });
    process.stdout.write(
      `Risk sweep: assessed ${summary.actorsAssessed} actors, flagged ${summary.actorsFlagged}, `
      + `${summary.recordFailures} event write(s) failed.\n`,
    );
    // A flagged actor whose event could not be written is a lost finding: exit
    // non-zero so the scheduler does not treat it as a clean run.
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
