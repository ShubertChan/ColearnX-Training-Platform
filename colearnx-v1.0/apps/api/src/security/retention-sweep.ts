type RetentionClient = {
  query(sql: string, parameters?: number[]): Promise<{ rowCount: number | null }>;
  release(): void;
};

type RetentionPool = {
  connect(): Promise<RetentionClient>;
};

const invalidRetentionDays = 'SECURITY_EVENT_RETENTION_DAYS must be an integer between 30 and 730.';

function validateRetentionDays(days: number): number {
  if (!Number.isInteger(days) || days < 30 || days > 730) {
    throw new Error(invalidRetentionDays);
  }
  return days;
}

export function parseRetentionDays(value: string | undefined): number {
  const configured = value ?? '180';
  // Do not truncate malformed values such as "30junk" or "30.5" into a
  // shorter retention period that would erase evidence earlier than intended.
  if (!/^\d+$/.test(configured)) throw new Error(invalidRetentionDays);
  return validateRetentionDays(Number(configured));
}

/** The caller supplies the owner pool; importing this module opens no connection. */
export async function runSecurityRetention(pool: RetentionPool, retentionDays = 180) {
  validateRetentionDays(retentionDays);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const events = await client.query(
      `DELETE FROM security_events WHERE occurred_at < now() - ($1 * interval '1 day')`,
      [retentionDays],
    );
    const tokens = await client.query(
      `DELETE FROM password_reset_challenges
        WHERE (consumed_at IS NOT NULL OR expires_at < now())
          AND requested_at < now() - interval '30 days'`,
    );
    // Both deletions must succeed before either becomes durable. This also
    // gives both cutoffs the same transaction timestamp.
    await client.query('COMMIT');
    return { eventsRemoved: events.rowCount ?? 0, tokensRemoved: tokens.rowCount ?? 0 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
