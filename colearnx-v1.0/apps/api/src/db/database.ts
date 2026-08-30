import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { env } from '../config/env.js';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
});

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
  return pool.query<T>(text, values);
}

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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

export async function closeDatabase() {
  await pool.end();
}
