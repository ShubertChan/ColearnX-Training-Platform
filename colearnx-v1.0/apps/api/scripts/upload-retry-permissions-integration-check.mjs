/**
 * Opt-in real PostgreSQL 16 permission/HTTP regression checks.
 * Requires a NEW empty database in a disposable, local, test-only cluster:
 * RELEASE_CHECK_DATABASE_URL=postgresql://owner:...@127.0.0.1:port/colearnx_release_check_<unique>
 * Run from apps/api: node --import tsx scripts/upload-retry-permissions-integration-check.mjs
 * Never loads .env, connects remotely, erases fixtures, or calls cloud services.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mock } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { S3Client } from '@aws-sdk/client-s3';
import { migrationChecksum } from '../src/db/migration-checksum.ts';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationDirectory = join(apiRoot, '../../db/migrations');
const permissionMigration = '018_upload_retry_expiry_permissions.sql';
const rawUrl = process.env.RELEASE_CHECK_DATABASE_URL;
assert.ok(rawUrl, 'Set RELEASE_CHECK_DATABASE_URL to a new disposable LOCAL PostgreSQL 16 database.');
const ownerUrl = new URL(rawUrl);
assert.ok(['postgres:', 'postgresql:'].includes(ownerUrl.protocol), 'PostgreSQL URL required.');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(ownerUrl.hostname), 'Remote databases are prohibited.');
const databaseName = decodeURIComponent(ownerUrl.pathname.slice(1));
assert.match(databaseName, /^colearnx_release_check_[a-z0-9_]+$/, 'Use a uniquely named disposable test database.');
assert.equal(ownerUrl.search, '', 'Connection URL options are prohibited.');
assert.equal(ownerUrl.hash, '', 'Connection URL fragments are prohibited.');

// Isolate both pg's environment defaults and every inherited cloud credential.
const operatingEnvironment = {};
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE']) {
  if (process.env[key]) operatingEnvironment[key] = process.env[key];
}
for (const key of Object.keys(process.env)) delete process.env[key];
const runtimePassword = randomBytes(32).toString('hex');
const runtimeUrl = new URL(ownerUrl.href);
runtimeUrl.username = 'colearnx_app'; runtimeUrl.password = runtimePassword;
Object.assign(process.env, operatingEnvironment, {
  NODE_ENV: 'development', DATABASE_URL: runtimeUrl.href, DATABASE_SSL: 'false', DB_POOL_MAX: '4',
  DOTENV_CONFIG_PATH: process.platform === 'win32' ? 'NUL' : '/dev/null', DOTENV_CONFIG_QUIET: 'true',
  APP_ORIGIN: 'http://localhost:5173', API_ORIGIN: 'http://localhost:3001',
  ACCESS_TOKEN_SECRET: randomBytes(32).toString('hex'), REFRESH_TOKEN_SECRET: randomBytes(32).toString('hex'),
  CSRF_SECRET: randomBytes(32).toString('hex'), LOG_LEVEL: 'silent',
  EMAIL_PROVIDER: 'disabled', PWNED_PASSWORDS_ENABLED: 'false', REDIS_URL: '',
  OBJECT_STORAGE_PROVIDER: 'r2', R2_ACCOUNT_ID: 'fixture-account', R2_ACCESS_KEY_ID: 'fixture-key',
  R2_SECRET_ACCESS_KEY: 'fixture-secret', R2_BUCKET_NAME: 'fixture-bucket', ENABLE_HOSTED_VIDEO: 'false',
});
let externalCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { externalCalls++; throw new Error('External HTTP is prohibited.'); };
// Signing is real and local, with inert test credentials; object I/O is blocked.
mock.method(S3Client.prototype, 'send', async () => { externalCalls++; throw new Error('External object storage is prohibited.'); });

const owner = new Pool({ connectionString: ownerUrl.href, ssl: false, max: 1, connectionTimeoutMillis: 5000 });
let runtime;
let checks = 0;
function passed(message) { checks++; process.stdout.write(`PASS ${message}\n`); }
const permissionDenied = (error) => error.code === '42501';

async function migrate() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/db/migrate.ts'], {
      cwd: apiRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MIGRATION_DATABASE_URL: ownerUrl.href },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`Migration failed: ${stderr.trim()}`));
      else resolve(stdout.trim().split('\n').map(line => line.trim()).filter(Boolean));
    });
  });
}

try {
  const version = (await owner.query('SHOW server_version_num')).rows[0].server_version_num;
  assert.equal(Math.floor(Number(version) / 10000), 16, 'PostgreSQL 16 is required, matching staging.');
  assert.equal((await owner.query('SELECT current_database() AS name')).rows[0].name, databaseName);
  const databases = await owner.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'");
  assert.ok(databases.rows.every(row => /^colearnx_release_check_[a-z0-9_]+$/.test(row.datname)),
    'Refusing a cluster containing non-test databases. Use a disposable container.');
  const relations = await owner.query(`SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`);
  assert.equal(relations.rows[0].count, 0, 'Target database must be empty; this script never erases existing data.');

  for (const role of ['colearnx_app', 'colearnx_migrator', 'colearnx_readonly']) {
    if (!(await owner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount) {
      await owner.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    }
  }
  // The password is random hexadecimal, never inherited or printed. This is a
  // genuinely restricted login, not an owner connection running SET ROLE.
  await owner.query(`ALTER ROLE colearnx_app LOGIN PASSWORD '${runtimePassword}'`);
  const flags = (await owner.query(`SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit
    FROM pg_roles WHERE rolname = 'colearnx_app'`)).rows[0];
  assert.ok(Object.values(flags).every(flag => flag === false), 'Runtime role must be unprivileged.');
  assert.equal((await owner.query(`SELECT count(*)::int AS count FROM pg_auth_members
    WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'colearnx_app')`)).rows[0].count, 0);
  passed('empty local test-only PG16 database and unprivileged runtime login');

  await owner.query(`CREATE TABLE schema_migrations (filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(migrationDirectory)).filter(file => file.endsWith('.sql')).sort();
  const baseline = files.filter(file => Number(file.slice(0, 3)) <= 17);
  assert.equal(baseline.length, 17, 'The pre-fix baseline must contain migrations 001-017.');
  for (const filename of baseline) {
    const sql = await readFile(join(migrationDirectory, filename), 'utf8');
    await owner.query('BEGIN');
    try {
      await owner.query(sql);
      await owner.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [filename, migrationChecksum(sql)]);
      await owner.query('COMMIT');
    } catch (error) { await owner.query('ROLLBACK'); throw error; }
  }
  const ledgerBefore = (await owner.query('SELECT * FROM schema_migrations ORDER BY filename')).rows;
  const database = await import('../src/db/database.ts'); runtime = database.pool;
  assert.deepEqual((await runtime.query('SELECT session_user, current_user')).rows[0],
    { session_user: 'colearnx_app', current_user: 'colearnx_app' });
  const { createApp } = await import('../src/app.ts');
  const app = createApp();
  const userId = randomUUID(); const sessionId = randomUUID();
  await owner.query(`INSERT INTO users (user_id, full_name, email, password_hash)
    VALUES ($1, 'Upload Retry Fixture', 'upload-retry@example.test', 'fixture-not-a-login-hash')`, [userId]);
  await owner.query(`INSERT INTO roles (role_code, role_name, description)
    VALUES ('creator', 'Creator', 'Fixture'), ('trainer', 'Trainer', 'Fixture')`);
  await owner.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, role_id FROM roles', [userId]);
  await owner.query(`INSERT INTO trainer_certifications (trainer_user_id, certification_name, certification_status)
    VALUES ($1, 'Fixture certification', 'approved')`, [userId]);
  await owner.query(`INSERT INTO refresh_sessions (session_id, user_id, token_hash, expires_at)
    VALUES ($1, $2, $3, now() + interval '1 hour')`, [sessionId, userId, createHash('sha256').update(randomBytes(32)).digest('hex')]);
  const token = jwt.sign({ sub: userId, sid: sessionId }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '10m' });
  const contentId = randomUUID(); const versionId = randomUUID();
  const courseId = randomUUID(); const runId = randomUUID();
  await owner.query(`INSERT INTO contents (content_id, creator_user_id, title, content_type, price_points)
    VALUES ($1, $2, 'Fixture content', 'digital', 100)`, [contentId, userId]);
  await owner.query('INSERT INTO content_versions (content_version_id, content_id, version_no) VALUES ($1, $2, 1)', [versionId, contentId]);
  await owner.query("INSERT INTO courses (course_id, owner_user_id, title) VALUES ($1, $2, 'Fixture course')", [courseId, userId]);
  await owner.query(`INSERT INTO course_runs (course_run_id, course_id, run_code, price_points, primary_delivery_type)
    VALUES ($1, $2, 'fixture-upload-retry', 100, 'cloud')`, [runId, courseId]);

  const fixtures = [
    { kind: 'content', base: `/api/v1/content-versions/${versionId}`, table: 'storage_assets', idColumn: 'storage_asset_id', parentColumn: 'content_version_id', parentId: versionId },
    { kind: 'course', base: `/api/v1/courses/${runId}`, table: 'course_delivery_assets', idColumn: 'course_delivery_asset_id', parentColumn: 'course_run_id', parentId: runId },
  ];
  const metadata = { filename: 'lesson.mp4', mediaType: 'video/mp4', sizeBytes: 104857600 };
  const uploadRequest = f => request(app).post(`${f.base}/upload-intents`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', f.key).send(metadata);
  const expire = f => owner.query(`UPDATE ${f.table} SET created_at = now() - interval '1 day', upload_expires_at = now() - interval '1 minute'
    WHERE ${f.idColumn} = $1`, [f.assetId]);
  const snapshot = async () => (await runtime.query(`SELECT 'content' AS kind, storage_asset_id AS id, upload_expires_at, updated_at FROM storage_assets
    UNION ALL SELECT 'course', course_delivery_asset_id, upload_expires_at, updated_at FROM course_delivery_assets ORDER BY kind, id`)).rows;

  for (const f of fixtures) {
    f.key = randomUUID();
    f.assetId = (await uploadRequest(f).expect(201)).body.data.assetId;
    await expire(f);
    await assert.rejects(runtime.query(`UPDATE ${f.table} SET upload_expires_at = upload_expires_at WHERE ${f.idColumn} = $1`, [f.assetId]), permissionDenied);
    const response = await uploadRequest(f).expect(500);
    assert.equal(response.body.error.code, 'INTERNAL_ERROR');
  }
  passed('both real HTTP expired retries reproduce the pre-migration PostgreSQL 42501 permission failure');

  const rowsBefore = await snapshot();
  const updateGrants = async () => (await owner.query(`SELECT table_name, column_name, is_grantable FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND table_name IN ('storage_assets', 'course_delivery_assets')
      AND grantee = 'colearnx_app' AND privilege_type = 'UPDATE' ORDER BY table_name, column_name`)).rows;
  const grantsBefore = await updateGrants();
  const applied = await migrate();
  assert.deepEqual(await snapshot(), rowsBefore, 'Permission migration must not change file records.');
  assert.deepEqual((await owner.query('SELECT * FROM schema_migrations ORDER BY filename')).rows.slice(0, 17), ledgerBefore,
    'Previously applied migration records must remain unchanged.');
  const grantsAfter = await updateGrants();
  assert.deepEqual(grantsAfter.filter(row => !grantsBefore.some(before => JSON.stringify(before) === JSON.stringify(row))), [
    { table_name: 'course_delivery_assets', column_name: 'upload_expires_at', is_grantable: 'NO' },
    { table_name: 'storage_assets', column_name: 'upload_expires_at', is_grantable: 'NO' },
  ]);
  assert.ok(grantsBefore.every(before => grantsAfter.some(row => JSON.stringify(before) === JSON.stringify(row))),
    'Existing column permissions must remain unchanged.');
  passed('only the two required expiry-column grants are added, without grant option or file-data changes');

  // This is the original failure before 018 exists: the real restricted
  // account must successfully renew, not just satisfy a mocked SQL assertion.
  for (const f of fixtures) {
    for (let attempt = 0; attempt < 6; attempt++) {
      await expire(f);
      const response = await uploadRequest(f).expect(201);
      assert.equal(response.body.data.assetId, f.assetId);
      assert.ok(new Date(response.body.data.expiresAt).getTime() > Date.now());
    }
    const assets = (await request(app).get(`${f.base}/assets`).set('Authorization', `Bearer ${token}`).expect(200)).body.data.assets;
    assert.equal(assets.length, 1); assert.equal(assets[0].assetId, f.assetId);
    await assert.rejects(runtime.query(`UPDATE ${f.table} SET owner_user_id = owner_user_id WHERE ${f.idColumn} = $1`, [f.assetId]), permissionDenied);
    await assert.rejects(runtime.query(`UPDATE ${f.table} SET declared_byte_size = declared_byte_size WHERE ${f.idColumn} = $1`, [f.assetId]), permissionDenied);
    await assert.rejects(runtime.query(`DELETE FROM ${f.table} WHERE ${f.idColumn} = $1`, [f.assetId]), permissionDenied);
    assert.equal((await runtime.query('SELECT has_table_privilege(current_user, $1, $2) AS allowed', [`public.${f.table}`, 'UPDATE'])).rows[0].allowed, false);
    passed(`${f.kind}: six expired retries renew the same asset, while unrelated column/table privileges remain restricted`);
  }
  assert.deepEqual(applied, [`Applied ${permissionMigration}`]);
  const usage = (await runtime.query(`SELECT count(*)::int AS assets, sum(declared_byte_size)::text AS bytes FROM (
    SELECT declared_byte_size FROM storage_assets WHERE owner_user_id = $1 AND asset_status <> 'deleted'
    UNION ALL SELECT declared_byte_size FROM course_delivery_assets WHERE owner_user_id = $1 AND asset_status <> 'deleted'
  ) reservations`, [userId])).rows[0];
  assert.deepEqual(usage, { assets: 2, bytes: '209715200' });
  const { assertAccountStorageQuota } = await import('../src/storage/storage-quota.ts');
  await database.withTransaction(client => assertAccountStorageQuota(client, userId, 314572800, { maxBytes: 524288000, maxPendingUploads: 3 }));
  passed('combined Creator/Trainer quota remains exactly 200 MiB after 12 renewals, with 300 MiB still available');

  await assert.rejects(runtime.query('CREATE TABLE prohibited_runtime_ddl (id int)'), permissionDenied);
  await assert.rejects(runtime.query('SELECT * FROM schema_migrations'), permissionDenied);
  const ledgerAfter = (await owner.query('SELECT * FROM schema_migrations ORDER BY filename')).rows;
  assert.deepEqual(await migrate(), []);
  assert.deepEqual((await owner.query('SELECT * FROM schema_migrations ORDER BY filename')).rows, ledgerAfter);
  passed('forward migration is ledgered once; rerunning it is a no-op without broadening runtime privileges');

  for (const f of fixtures) {
    await owner.query(`UPDATE ${f.table} SET asset_status = 'ready', verified_content_type = declared_content_type,
      verified_byte_size = declared_byte_size, verified_at = now() WHERE ${f.idColumn} = $1`, [f.assetId]);
    const replay = (await uploadRequest(f).expect(200)).body.data;
    assert.equal(replay.assetId, f.assetId); assert.equal(replay.status, 'ready'); assert.equal(replay.uploadUrl, undefined);
  }
  assert.equal(externalCalls, 0);
  passed('already-uploaded files recover without another upload URL or any external cloud requests');
  process.stdout.write(`Completed ${checks} real low-privilege PostgreSQL/HTTP integration checks.\n`);
} finally {
  await runtime?.end();
  await owner.end();
  mock.restoreAll(); globalThis.fetch = originalFetch;
}
