import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appDirectory, migrationInventory, requireCommit, sha256 } from './artifact.mjs';
import { matchesMigrationChecksum } from '../../apps/api/src/db/migration-checksum.ts';

const readerRole = 'colearnx_release_reader';
class MigrationError extends Error {}
const requireValue = (condition, message) => { if (!condition) throw new MigrationError(message); };

/** Parse fields ourselves: URL sslmode/options must never override strict TLS or session settings. */
export function readCloudDatabaseConfig(env = process.env) {
  try {
    const url = new URL(env.STAGING_DATABASE_READONLY_URL);
    const host = env.STAGING_DATABASE_HOST;
    requireValue(typeof host === 'string' && /^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(host)
      && !host.split('.')[0].endsWith('-pooler'), 'Set the approved direct Neon STAGING_DATABASE_HOST.');
    requireValue(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === host
      && (!url.port || url.port === '5432') && !url.hash, 'Read-only database target does not match the approved Neon host.');
    requireValue(decodeURIComponent(url.username) === readerRole && decodeURIComponent(url.pathname.slice(1)) === 'colearnx'
      && url.password.length > 0 && !/[\r\n]/.test(decodeURIComponent(url.password)), 'Use the dedicated colearnx_release_reader login and colearnx database; never an Owner or application URL.');
    const allowed = { sslmode: ['require', 'verify-full'], channel_binding: ['require', 'prefer'] };
    for (const [key, value] of url.searchParams) {
      requireValue(allowed[key]?.includes(value) && url.searchParams.getAll(key).length === 1, 'Unsupported database URL options.');
    }
    return { host, port: 5432, database: 'colearnx', user: readerRole, password: decodeURIComponent(url.password),
      ssl: { rejectUnauthorized: true, servername: host }, enableChannelBinding: true,
      connectionTimeoutMillis: 10_000, query_timeout: 10_000, statement_timeout: 5_000,
      application_name: 'colearnx-release-readonly' };
  } catch (error) {
    throw error instanceof MigrationError ? error : new MigrationError('Configure STAGING_DATABASE_READONLY_URL in the protected staging Environment. No connection details were logged.');
  }
}

export function compareMigrationLedger(inventory, ledger, sqlByFilename) {
  requireValue(Array.isArray(inventory) && inventory.length > 0 && inventory.length <= 1000
    && inventory.every((row, i) => new RegExp(`^${String(i + 1).padStart(3, '0')}_[a-z0-9_]+\\.sql$`).test(row.filename)
      && /^[a-f0-9]{64}$/.test(row.checksum) && typeof sqlByFilename?.[row.filename] === 'string'
      && sha256(sqlByFilename[row.filename].replace(/\r\n?/g, '\n')) === row.checksum), 'Invalid checked-in migration inventory.');
  requireValue(Array.isArray(ledger) && ledger.length === inventory.length, 'Cloud migration count differs: missing or unexpected migrations. Stop and obtain migration approval separately.');
  const rows = [...ledger].sort((a, b) => String(a?.filename).localeCompare(String(b?.filename), 'en'));
  for (const [index, expected] of inventory.entries()) {
    const row = rows[index];
    requireValue(row?.filename === expected.filename && /^[a-f0-9]{64}$/.test(row.checksum ?? ''), 'Cloud migration filenames are missing, duplicated, unexpected or malformed.');
    requireValue(matchesMigrationChecksum(row.checksum, sqlByFilename[expected.filename]), 'Cloud migration checksum differs. Do not rewrite history; review a forward migration.');
    requireValue((row.applied_at instanceof Date || typeof row.applied_at === 'string')
      && Number.isFinite(new Date(row.applied_at).valueOf()), 'Cloud migration applied_at is missing or invalid.');
  }
  return { migrationCount: inventory.length, lastAppliedMigration: inventory.at(-1).filename,
    inventoryDigest: sha256(JSON.stringify(inventory)), ledgerDigest: sha256(JSON.stringify(rows.map(row => ({
      filename: row.filename, checksum: row.checksum, appliedAt: new Date(row.applied_at).toISOString(),
    })))) };
}

// Catalog inspection only. No business rows, grants, DDL, migrations or credentials are returned.
const identitySql = `SELECT current_database() AS database, current_user AS role, session_user AS session_role,
  current_setting('transaction_read_only') AS read_only,
  current_setting('default_transaction_read_only') AS default_read_only,
  r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolinherit, r.rolreplication, r.rolbypassrls,
  EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) AS memberships,
  EXISTS (SELECT 1 FROM pg_stat_ssl WHERE pid = pg_backend_pid() AND ssl) AS tls,
  has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
  EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    AND (n.nspowner = r.oid OR has_schema_privilege(current_user, n.oid, 'CREATE'))) AS schema_create,
  EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f')
    AND (c.relowner = r.oid OR has_table_privilege(current_user, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(current_user, c.oid, 'INSERT,UPDATE,REFERENCES'))) AS table_write,
  EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname !~ '^pg_' AND c.relkind = 'S'
    AND (c.relowner = r.oid OR has_sequence_privilege(current_user, c.oid, 'USAGE,UPDATE'))) AS sequence_write
  FROM pg_roles r WHERE r.rolname = current_user`;

/** Injectable client factory lets tests exercise the exact SQL against disposable local PostgreSQL. */
export async function verifyCloudMigrations({ config, inventory, sqlByFilename, commit, approved, lastApplied, clientFactory }) {
  requireCommit(commit);
  requireValue(approved === 'true' && lastApplied === inventory?.at(-1)?.filename, 'Manual migration approval and the exact final filename remain mandatory.');
  // Validate repository input before contacting any database.
  compareMigrationLedger(inventory, inventory.map(row => ({ ...row, applied_at: new Date(0) })), sqlByFilename);
  let client;
  let transaction = false;
  try {
    client = await clientFactory(config);
    client.on?.('error', () => { /* pg may include connection details in asynchronous errors. Never log them. */ });
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transaction = true;
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query('SET LOCAL search_path = pg_catalog');
    const identity = (await client.query(identitySql)).rows?.[0];
    requireValue(identity?.database === config.database && identity.role === readerRole && identity.session_role === readerRole
      && identity.read_only === 'on' && identity.default_read_only === 'on', 'Database identity or read-only session does not match the dedicated release reader.');
    requireValue(['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolinherit', 'rolreplication', 'rolbypassrls', 'memberships',
      'database_create', 'schema_create', 'table_write', 'sequence_write'].every(key => identity[key] === false), 'Release reader has unexpected ownership, write, membership or administrative privileges.');
    requireValue(identity.tls === true || config.testOnlyLocalTransport === true, 'Cloud database connection must use verified TLS.');
    const ledger = await client.query('SELECT filename, checksum, applied_at FROM public.schema_migrations ORDER BY filename LIMIT 1001');
    return { schemaVersion: 1, commit, result: 'verified', database: config.database, role: readerRole,
      ...compareMigrationLedger(inventory, ledger.rows, sqlByFilename), checkedAt: new Date().toISOString() };
  } catch (error) {
    throw error instanceof MigrationError ? error : new MigrationError('Cloud migration preflight could not be completed. Check read-only credentials, permissions, connectivity and ledger; no deployment is permitted.');
  } finally {
    if (client) {
      if (transaction) { try { await client.query('ROLLBACK'); } catch { /* Always close the read-only session. */ } }
      try { await client.end(); } catch { /* Never echo driver errors or connection information. */ }
    }
  }
}

async function main() {
  const phase = process.argv[2];
  requireValue(process.argv.length === 3 && ['before', 'after'].includes(phase), 'Use cloud-migrations.mjs before|after.');
  const config = readCloudDatabaseConfig();
  const inventory = await migrationInventory();
  const sqlByFilename = Object.fromEntries(await Promise.all(inventory.map(async ({ filename }) => [filename,
    await readFile(resolve(appDirectory, 'db/migrations', filename), 'utf8')])));
  const require = createRequire(new URL('../../deployment/package.json', import.meta.url));
  const { Client } = require('pg');
  const report = await verifyCloudMigrations({ config, inventory, sqlByFilename, commit: process.env.RELEASE_SHA,
    approved: process.env.MIGRATIONS_REVIEWED, lastApplied: process.env.LAST_APPLIED_MIGRATION,
    clientFactory: settings => new Client(settings) });
  const directory = resolve(appDirectory, 'release-report');
  if (phase === 'after') {
    const before = JSON.parse(await readFile(resolve(directory, 'migrations-before.json'), 'utf8'));
    requireValue(before.commit === report.commit && before.ledgerDigest === report.ledgerDigest
      && before.inventoryDigest === report.inventoryDigest, 'Cloud migration ledger changed during release. Inspect both platforms before retrying.');
  }
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `migrations-${phase}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Verified actual cloud migration ledger (${report.migrationCount} migrations). No migration, grant or business-data write was executed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof MigrationError ? error.message : 'Cloud migration preflight failed; no sensitive details were logged.'); process.exitCode = 1; });
}
