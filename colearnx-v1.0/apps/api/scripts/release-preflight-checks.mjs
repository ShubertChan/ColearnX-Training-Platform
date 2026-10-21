/** Called only after the parent runner's empty/local PostgreSQL 16 safety checks. Never use Neon. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { appDirectory, migrationInventory } from '../../../scripts/deployment/artifact.mjs';
import { verifyCloudMigrations } from '../../../scripts/deployment/cloud-migrations.mjs';

export async function runReleasePreflightChecks({ owner, ownerUrl, passed }) {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(ownerUrl.hostname));
  const database = decodeURIComponent(ownerUrl.pathname.slice(1));
  assert.match(database, /^colearnx_release_check_[a-z0-9_]+$/);
  const role = 'colearnx_release_reader';
  const password = randomBytes(32).toString('hex');
  assert.equal((await owner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount, 0,
    'Use a fresh isolated cluster; never alter an existing release reader.');
  await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
  await owner.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
  await owner.query(`GRANT CONNECT ON DATABASE "${database}" TO ${role}`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await owner.query(`GRANT SELECT ON public.schema_migrations TO ${role}`);
  const url = new URL(ownerUrl);
  url.username = role; url.password = password;
  const inventory = await migrationInventory();
  const sqlByFilename = Object.fromEntries(await Promise.all(inventory.map(async ({ filename }) => [filename,
    await readFile(resolve(appDirectory, 'db/migrations', filename), 'utf8')])));
  const before = (await owner.query('SELECT filename, checksum, applied_at FROM public.schema_migrations ORDER BY filename')).rows;
  const verify = (overrides = {}) => verifyCloudMigrations({ config: { database, testOnlyLocalTransport: true }, inventory, sqlByFilename,
    commit: 'a'.repeat(40), approved: 'true', lastApplied: inventory.at(-1).filename,
    clientFactory: () => new Client({ connectionString: url.href, connectionTimeoutMillis: 5000, query_timeout: 10000 }), ...overrides });
  assert.equal((await verify()).migrationCount, inventory.length);
  assert.deepEqual((await owner.query('SELECT filename, checksum, applied_at FROM public.schema_migrations ORDER BY filename')).rows, before);
  passed('release preflight reads the actual ledger through a separate LOGIN/NOINHERIT read-only account without changing any migration row');

  const reader = new Client({ connectionString: url.href });
  await reader.connect();
  try {
    // Turning off the default read-only mode does not create any grants.
    await reader.query('SET default_transaction_read_only = off');
    await assert.rejects(reader.query('UPDATE public.schema_migrations SET checksum = checksum'), error => error.code === '42501');
    await assert.rejects(reader.query('SELECT * FROM public.users LIMIT 1'), error => error.code === '42501');
    await assert.rejects(reader.query('CREATE TABLE public.release_reader_must_not_create (id integer)'), error => error.code === '42501');
  } finally { await reader.end(); }
  passed('dedicated release reader cannot modify the ledger, read user data, or create public tables even in a READ WRITE session');

  const last = before.at(-1);
  try {
    await owner.query('UPDATE public.schema_migrations SET checksum = $1 WHERE filename = $2', ['f'.repeat(64), last.filename]);
    await assert.rejects(verify(), /checksum differs/);
  } finally { await owner.query('UPDATE public.schema_migrations SET checksum = $1 WHERE filename = $2', [last.checksum, last.filename]); }
  try {
    await owner.query('DELETE FROM public.schema_migrations WHERE filename = $1', [last.filename]);
    await assert.rejects(verify(), /migration count differs/);
  } finally {
    await owner.query('INSERT INTO public.schema_migrations (filename, checksum, applied_at) VALUES ($1, $2, $3)', [last.filename, last.checksum, last.applied_at]);
  }
  passed('real missing and mismatched historical ledger records block preflight; fixture ledger is restored exactly afterwards');

  try {
    await owner.query(`GRANT UPDATE (checksum) ON public.schema_migrations TO ${role}`);
    await assert.rejects(verify(), /unexpected ownership, write/);
  } finally { await owner.query(`REVOKE UPDATE (checksum) ON public.schema_migrations FROM ${role}`); }
  try {
    await owner.query(`REVOKE SELECT ON public.schema_migrations FROM ${role}`);
    await assert.rejects(verify(), /could not be completed/);
  } finally { await owner.query(`GRANT SELECT ON public.schema_migrations TO ${role}`); }
  await assert.rejects(verify({ approved: 'false', clientFactory: () => assert.fail('Approval must precede connecting') }), /Manual migration approval/);
  assert.equal((await verify()).result, 'verified');
  assert.deepEqual((await owner.query('SELECT filename, checksum, applied_at FROM public.schema_migrations ORDER BY filename')).rows, before);
  passed('column-level privilege escalation and ledger permission loss fail closed; manual approval remains mandatory');
}
