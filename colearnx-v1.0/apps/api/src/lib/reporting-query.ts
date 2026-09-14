import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../db/database.js';
import { ApiError } from './http.js';

/**
 * In a query string an empty value means "not supplied", not "invalid", so a
 * cleared date or search box must not fail validation.
 */
export const optionalTrimmedText = (max: number) => z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().max(max).optional(),
);

/** A reporting boundary; resolveUtcDateRange validates the calendar shape. */
export const optionalReportingDate = optionalTrimmedText(10);

/**
 * A reporting response is several aggregates that have to agree with each
 * other, so they are read from one repeatable-read snapshot rather than from
 * several points in time. The transaction is read only: nothing here writes.
 */
export async function withReadOnlySnapshot<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Postgres returns counts and sums as text because they can exceed a double.
 * Refuse a figure JSON cannot carry exactly instead of shipping a rounded one.
 */
export function safeMetric(value: string, metric: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ApiError(503, 'METRIC_OUT_OF_RANGE', `${metric} cannot be represented safely.`);
  }
  return parsed;
}
