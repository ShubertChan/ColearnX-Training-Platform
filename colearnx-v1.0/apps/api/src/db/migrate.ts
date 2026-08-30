import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { env } from '../config/env.js';

const rootDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const migrationsDirectory = join(rootDirectory, 'db', 'migrations');
const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('MIGRATION_DATABASE_URL is required for migrations; do not run schema changes with the API role.');
const pool = new Pool({ connectionString: migrationDatabaseUrl, ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined });

async function main() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
  for (const filename of files) {
    const sql = await readFile(join(migrationsDirectory, filename), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const prior = await pool.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE filename = $1', [filename]);
    if (prior.rowCount) {
      if (prior.rows[0].checksum !== checksum) throw new Error(`Migration checksum changed: ${filename}. Create a forward migration instead.`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [filename, checksum]);
      await client.query('COMMIT');
      process.stdout.write(`Applied ${filename}\n`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

main().then(() => pool.end()).catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  await pool.end();
  process.exitCode = 1;
});
