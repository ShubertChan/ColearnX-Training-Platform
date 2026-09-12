/**
 * Opt-in PostgreSQL 16 release checks. Never run against staging/production.
 * Start a NEW disposable local PostgreSQL container and provide its empty DB as
 * RELEASE_CHECK_DATABASE_URL. The DB name must start colearnx_release_check_.
 * Run from apps/api: node --import tsx scripts/release-integration-check.mjs
 * No cloud credentials, seed, restore, DROP, or external email/payment/storage
 * calls are used. Test rows/databases are left in the disposable container.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { migrationChecksum } from '../src/db/migration-checksum.ts';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationDirectory = join(apiRoot, '../../db/migrations');
const rawUrl = process.env.RELEASE_CHECK_DATABASE_URL;
if (!rawUrl) throw new Error('Set RELEASE_CHECK_DATABASE_URL to a new disposable LOCAL PostgreSQL 16 database.');
const ownerUrl = new URL(rawUrl);
const dbName = decodeURIComponent(ownerUrl.pathname.slice(1));
assert.ok(['postgres:', 'postgresql:'].includes(ownerUrl.protocol), 'PostgreSQL URL required.');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(ownerUrl.hostname), 'Remote databases are prohibited.');
assert.match(dbName, /^colearnx_release_check_[a-z0-9_]+$/, 'Use a uniquely named disposable release-check database.');
assert.equal(ownerUrl.search, '', 'Do not supply connection URL options.');

const owner = new Pool({ connectionString: ownerUrl.href, max: 2 });
let apiPool;
let freshPool;
let checks = 0;
function passed(message) { checks += 1; process.stdout.write(`PASS ${message}\n`); }
function quoteIdentifier(value) { return `"${value.replaceAll('"', '""')}"`; }

// Supply a minimal environment; dotenv must not load a developer's .env.
function testEnvironment(databaseUrl) {
  const environment = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return {
    ...environment,
    NODE_ENV: 'development',
    DATABASE_URL: databaseUrl,
    MIGRATION_DATABASE_URL: databaseUrl,
    DATABASE_SSL: 'false',
    DB_POOL_MAX: '2',
    DOTENV_CONFIG_PATH: join(apiRoot, 'scripts', '__release_check_no_dotenv__'),
    APP_ORIGIN: 'http://localhost:5173',
    API_ORIGIN: 'http://localhost:3001',
    ACCESS_TOKEN_SECRET: randomBytes(32).toString('hex'),
    REFRESH_TOKEN_SECRET: randomBytes(32).toString('hex'),
    CSRF_SECRET: randomBytes(32).toString('hex'),
    EMAIL_PROVIDER: 'disabled',
    OBJECT_STORAGE_PROVIDER: 'disabled',
    STRIPE_MODE: 'test',
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    LOG_LEVEL: 'silent',
  };
}

async function migrate(databaseUrl) {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/db/migrate.ts'], {
      cwd: apiRoot, env: testEnvironment(databaseUrl), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (value) => { stdout += value; });
    child.stderr.on('data', (value) => { stderr += value; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`Migration failed (${code}): ${stderr}`)));
  });
  return output.trim().split('\n').map((line) => line.trim()).filter(Boolean);
}

async function snapshotOldTables(client) {
  const tables = await client.query(`SELECT table_name, array_agg(column_name::text ORDER BY ordinal_position) AS columns
    FROM information_schema.columns WHERE table_schema = 'public' GROUP BY table_name ORDER BY table_name`);
  const snapshot = [];
  for (const table of tables.rows) {
    const sql = `SELECT ${table.columns.map(quoteIdentifier).join(', ')} FROM public.${quoteIdentifier(table.table_name)}`;
    const result = await client.query(sql);
    snapshot.push({ sql, rows: result.rows.map((row) => JSON.stringify(row)).sort() });
  }
  return snapshot;
}

try {
  const version = await owner.query('SHOW server_version_num');
  assert.equal(Math.floor(Number(version.rows[0].server_version_num) / 10000), 16, 'Use PostgreSQL 16, matching Neon.');
  const databases = await owner.query(`SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'`);
  assert.ok(databases.rows.every((row) => /^colearnx_release_check_[a-z0-9_]+$/.test(row.datname)),
    'Refusing a cluster containing non-test databases. Use a new disposable container.');
  const existing = await owner.query(`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public'`);
  assert.equal(existing.rows[0].count, 0, 'Target database must be empty; this script will not erase or restore it.');
  for (const role of ['colearnx_app', 'colearnx_migrator', 'colearnx_readonly']) {
    const result = await owner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (!result.rowCount) await owner.query(`CREATE ROLE ${quoteIdentifier(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  }
  passed('isolated empty local PostgreSQL 16 database safety checks');

  await owner.query(`CREATE TABLE schema_migrations (filename text PRIMARY KEY, checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now())`);
  const migrationFiles = (await readdir(migrationDirectory)).filter((file) => file.endsWith('.sql')).sort();
  assert.deepEqual(migrationFiles.map((file) => file.slice(0, 3)), ['001', '002', '003', '004', '005', '006', '007', '008']);
  const connection = await owner.connect();
  try {
    for (const filename of migrationFiles.slice(0, 7)) {
      const sql = await readFile(join(migrationDirectory, filename), 'utf8');
      await connection.query('BEGIN');
      try {
        await connection.query(sql);
        await connection.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [filename, migrationChecksum(sql)]);
        await connection.query('COMMIT');
      } catch (error) { await connection.query('ROLLBACK'); throw error; }
    }
  } finally { connection.release(); }
  passed('001–007 SQL applied to a fresh fixture database');

  const buyerId = randomUUID(); const sellerId = randomUUID(); const adminId = randomUUID();
  const contentId = randomUUID(); const versionId = randomUUID(); const cartId = randomUUID();
  const courseId = randomUUID(); const courseRunId = randomUUID(); const oldCartItemId = randomUUID();
  for (const [id, name, email] of [[buyerId, 'Fixture Buyer', 'buyer@example.test'], [sellerId, 'Fixture Seller', 'seller@example.test'], [adminId, 'Fixture Admin', 'admin@example.test']]) {
    await owner.query(`INSERT INTO users (user_id, full_name, email, password_hash) VALUES ($1, $2, $3, 'fixture-not-a-login-hash')`, [id, name, email]);
  }
  await owner.query(`INSERT INTO roles (role_code, role_name, description) VALUES ('member', 'Member', 'Fixture'), ('admin', 'Admin', 'Fixture')`);
  await owner.query(`INSERT INTO user_roles (user_id, role_id) SELECT u.user_id, r.role_id FROM users u CROSS JOIN roles r
    WHERE r.role_code = 'member' OR (u.user_id = $1 AND r.role_code = 'admin')`, [adminId]);
  await owner.query(`INSERT INTO contents (content_id, creator_user_id, title, content_type, price_points, publication_status)
    VALUES ($1, $2, 'Preserved content', 'digital', 125, 'published')`, [contentId, sellerId]);
  await owner.query(`INSERT INTO content_versions (content_version_id, content_id, version_no, version_status, published_at)
    VALUES ($1, $2, 1, 'published', now())`, [versionId, contentId]);
  await owner.query(`INSERT INTO courses (course_id, owner_user_id, title, publication_status)
    VALUES ($1, $2, 'Preserved course', 'published')`, [courseId, sellerId]);
  await owner.query(`INSERT INTO course_runs (course_run_id, course_id, run_code, run_status, price_points, primary_delivery_type)
    VALUES ($1, $2, 'fixture-course-run', 'published', 250, 'cloud')`, [courseRunId, courseId]);
  await owner.query(`INSERT INTO course_delivery_options (course_run_id, delivery_type, access_mode, is_primary)
    VALUES ($1, 'cloud', 'on_demand', true)`, [courseRunId]);
  await owner.query(`INSERT INTO carts (cart_id, buyer_user_id) VALUES ($1, $2)`, [cartId, buyerId]);
  await owner.query(`INSERT INTO cart_items (cart_item_id, cart_id, item_type, content_version_id, points_snapshot)
    VALUES ($1, $2, 'content_version', $3, 125)`, [oldCartItemId, cartId, versionId]);
  const oldSnapshot = await snapshotOldTables(owner);
  const ledgerBefore = await owner.query('SELECT * FROM schema_migrations ORDER BY filename');
  assert.deepEqual(await migrate(ownerUrl.href), ['Applied 008_frontend_delivery_backend.sql']);
  for (const snapshot of oldSnapshot) {
    if (snapshot.sql.includes('"schema_migrations"')) continue;
    const rows = await owner.query(snapshot.sql);
    assert.deepEqual(rows.rows.map((row) => JSON.stringify(row)).sort(), snapshot.rows, `Existing rows changed: ${snapshot.sql}`);
  }
  const ledgerAfter = await owner.query('SELECT * FROM schema_migrations ORDER BY filename');
  assert.equal(ledgerAfter.rowCount, 8);
  assert.deepEqual(ledgerAfter.rows.slice(0, 7), ledgerBefore.rows);
  passed('008 through the real migration runner preserved all pre-existing table rows and old migration records');
  assert.deepEqual(await migrate(ownerUrl.href), []);
  assert.deepEqual((await owner.query('SELECT * FROM schema_migrations ORDER BY filename')).rows, ledgerAfter.rows);
  passed('second migration invocation is a no-op, including applied timestamps/checksums');

  const freshName = `${dbName}_fresh`;
  await owner.query(`CREATE DATABASE ${quoteIdentifier(freshName)}`);
  const freshUrl = new URL(ownerUrl.href); freshUrl.pathname = `/${freshName}`;
  assert.deepEqual(await migrate(freshUrl.href), migrationFiles.map((file) => `Applied ${file}`));
  freshPool = new Pool({ connectionString: freshUrl.href, max: 1 });
  assert.equal((await freshPool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count, 8);
  passed('complete 001–008 fresh installation through the real migration runner');

  // A dedicated pool defaults every connection to SET ROLE colearnx_app. The
  // SQL checks therefore exercise the real runtime role's object privileges.
  const runtimeUrl = new URL(ownerUrl.href);
  runtimeUrl.searchParams.set('options', '-c role=colearnx_app');
  const environment = testEnvironment(runtimeUrl.href);
  for (const key of Object.keys(process.env)) {
    if (/^(DATABASE_|MIGRATION_|STRIPE_|R2_|RESEND_|EMAIL_|OBJECT_STORAGE_|ENABLE_|COOKIE_|APP_ORIGIN|API_ORIGIN|NODE_ENV|DOTENV_|.*_TOKEN_SECRET|CSRF_SECRET|LOG_LEVEL)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, environment);
  const database = await import('../src/db/database.ts'); apiPool = database.pool;
  assert.equal((await apiPool.query('SELECT current_user')).rows[0].current_user, 'colearnx_app');
  await assert.rejects(apiPool.query('SELECT * FROM schema_migrations'), (error) => error.code === '42501');
  await assert.rejects(apiPool.query('CREATE TABLE prohibited_runtime_ddl (id int)'), (error) => error.code === '42501');
  await assert.rejects(apiPool.query('UPDATE point_transactions SET transaction_type = transaction_type'), (error) => error.code === '42501');
  await assert.rejects(apiPool.query('DELETE FROM admin_action_logs'), (error) => error.code === '42501');
  for (const table of ['course_delivery_assets', 'course_video_progress_sessions', 'password_reset_challenges', 'privacy_requests']) {
    await apiPool.query(`SELECT * FROM ${quoteIdentifier(table)} LIMIT 1`);
  }
  passed('colearnx_app can access new operational tables but cannot create schema objects/read migration ledger/mutate immutable ledgers');

  const { createApp } = await import('../src/app.ts');
  const app = createApp();
  const accessToken = (id) => jwt.sign({ sub: id }, environment.ACCESS_TOKEN_SECRET, { expiresIn: '5m' });
  const buyerToken = accessToken(buyerId);
  await request(app).get('/health/ready').expect(200);
  const listing = await request(app).get('/api/v1/content').expect(200);
  const detail = await request(app).get(`/api/v1/content/${versionId}`).expect(200);
  assert.ok(detail.body.data.refundPolicyPreview?.rule, 'Content detail must expose a recognised refund policy.');
  assert.ok(detail.body.data.refundPolicyPreview?.summary, 'Content refund policy must include a readable summary.');
  assert.deepEqual(listing.body.data.find((item) => item.id === versionId).refundPolicyPreview, detail.body.data.refundPolicyPreview);
  passed('real content list/detail API contract includes the same nonempty refund policy');

  const oldCart = await request(app).get('/api/v1/cart').set('Authorization', `Bearer ${buyerToken}`).expect(200);
  assert.equal(oldCart.body.data.items.find((item) => item.id === oldCartItemId).pricePoints, 125, 'Pre-008 cart prices must not become zero.');
  for (const item of [{ kind: 'content', id: versionId }, { kind: 'course', id: courseRunId }]) {
    await request(app).post('/api/v1/cart/items').set('Authorization', `Bearer ${buyerToken}`).send(item).expect(201);
    await request(app).post('/api/v1/cart/items').set('Authorization', `Bearer ${buyerToken}`).send(item).expect(201);
  }
  const storedCart = await request(app).get('/api/v1/cart').set('Authorization', `Bearer ${buyerToken}`).expect(200);
  assert.equal(storedCart.body.data.items.length, 2, 'Re-adding an item must not duplicate it.');
  assert.deepEqual(storedCart.body.data.items.map((item) => item.pricePoints).sort((a, b) => a - b), [125, 250]);
  const persistedPrices = await owner.query('SELECT points_snapshot, last_seen_price_points FROM cart_items WHERE cart_id = $1', [cartId]);
  assert.ok(persistedPrices.rows.every((row) => row.points_snapshot === row.last_seen_price_points));
  await request(app).post('/api/v1/cart/items').set('Authorization', `Bearer ${accessToken(sellerId)}`).send({ kind: 'content', id: versionId }).expect(403);
  await request(app).post('/api/v1/cart/items').set('Authorization', `Bearer ${accessToken(adminId)}`).send({ kind: 'content', id: versionId }).expect(403);
  await request(app).post('/api/v1/cart/items').send({ kind: 'content', id: versionId }).expect(401);
  await request(app).delete(`/api/v1/cart/items/${storedCart.body.data.items[0].id}`).set('Authorization', `Bearer ${accessToken(sellerId)}`).expect(404);
  await request(app).delete(`/api/v1/cart/items/${storedCart.body.data.items[0].id}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
  passed('real cart POST/GET/DELETE SQL, legacy price fallback, duplicate prevention and buyer/ownership authorisation');

  await owner.query(`INSERT INTO roles (role_code, role_name, description) VALUES ('trainer', 'Trainer', 'Fixture')`);
  await owner.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, role_id FROM roles WHERE role_code = 'trainer'`, [sellerId]);
  await owner.query(`INSERT INTO trainer_certifications (trainer_user_id, certification_name, certification_status)
    VALUES ($1, 'Fixture certification', 'approved')`, [sellerId]);
  const categoryId = randomUUID();
  await owner.query(`INSERT INTO categories (category_id, category_name, category_scope) VALUES ($1, 'Fixture category', 'course')`, [categoryId]);
  const draftPayload = {
    title: 'Metadata preservation fixture', description: 'Keep private delivery metadata', categoryId,
    pricePoints: 350, capacity: 17, startsAt: '2030-01-01T08:00:00.000Z', endsAt: '2030-01-01T10:00:00.000Z',
    timezone: 'Asia/Singapore', deliveryModes: ['live', 'record'],
    fulfilmentInstructions: 'Private fixture instructions', trainerContact: 'trainer@example.test',
    joinUrl: 'https://example.test/private-fixture', progressTrackingType: 'online_video', totalDurationSeconds: 300,
  };
  const trainerToken = accessToken(sellerId);
  const createdDraft = await request(app).post('/api/v1/courses').set('Authorization', `Bearer ${trainerToken}`).send(draftPayload).expect(201);
  const firstListings = await request(app).get('/api/v1/my/listings').set('Authorization', `Bearer ${trainerToken}`).expect(200);
  const savedDraft = firstListings.body.data.find((item) => item.id === createdDraft.body.data.id);
  for (const [key, value] of Object.entries(draftPayload)) assert.deepEqual(savedDraft[key], value, `Draft listings omitted ${key}`);
  const editPayload = Object.fromEntries(Object.keys(draftPayload).map((key) => [key, savedDraft[key]]));
  editPayload.title = 'Edited fixture title';
  await request(app).patch(`/api/v1/courses/${savedDraft.id}`).set('Authorization', `Bearer ${trainerToken}`).send(editPayload).expect(200);
  const afterEditListings = await request(app).get('/api/v1/my/listings').set('Authorization', `Bearer ${trainerToken}`).expect(200);
  const afterEditDraft = afterEditListings.body.data.find((item) => item.id === savedDraft.id);
  for (const [key, value] of Object.entries(editPayload)) assert.deepEqual(afterEditDraft[key], value, `Draft edit lost ${key}`);
  const publicCourse = await request(app).get(`/api/v1/courses/${courseRunId}`).expect(200);
  assert.equal('fulfilmentInstructions' in publicCourse.body.data, false);
  assert.equal('trainerContact' in publicCourse.body.data, false);
  assert.equal('joinUrl' in publicCourse.body.data, false);
  passed('real draft create/list/edit preserves category/timezone/schedule/delivery/video metadata; public catalog omits private delivery fields');

  const assetId = randomUUID();
  await apiPool.query(`INSERT INTO course_delivery_assets (course_delivery_asset_id, course_run_id, owner_user_id, asset_purpose,
    bucket_name, object_key, original_filename, declared_content_type, declared_byte_size, upload_expires_at)
    VALUES ($1, $2, $3, 'cloud_download', 'local-test-only', 'fixture/file.pdf', 'file.pdf', 'application/pdf', 123, now() + interval '10 minutes')`,
  [assetId, courseRunId, sellerId]);
  await assert.rejects(apiPool.query(`INSERT INTO course_delivery_assets (course_run_id, owner_user_id, asset_purpose,
    bucket_name, object_key, original_filename, declared_content_type, declared_byte_size, upload_expires_at)
    VALUES ($1, $2, 'cloud_download', 'local-test-only', 'fixture/wrong-owner.pdf', 'wrong-owner.pdf', 'application/pdf', 123, now() + interval '10 minutes')`,
  [courseRunId, buyerId]), (error) => /owner must match/.test(error.message));
  await assert.rejects(apiPool.query('UPDATE course_delivery_assets SET owner_user_id = $1 WHERE course_delivery_asset_id = $2', [buyerId, assetId]), (error) => error.code === '42501');
  await apiPool.query(`UPDATE course_delivery_assets SET asset_status = 'delete_pending', updated_at = now() WHERE course_delivery_asset_id = $1`, [assetId]);
  passed('course asset ownership trigger and column-level runtime update grants');

  const { assertAccountStorageQuota } = await import('../src/storage/storage-quota.ts');
  const { cleanupCandidateSql, reconcileStorage } = await import('../src/storage/storage-reconciliation.ts');
  await apiPool.query(`INSERT INTO storage_assets (content_version_id, owner_user_id, bucket_name, object_key,
    original_filename, declared_content_type, declared_byte_size, verified_byte_size, upload_expires_at)
    VALUES ($1, $2, 'local-test-only', 'fixture/content-quota.pdf', 'content-quota.pdf', 'application/pdf', 200, 250, now() + interval '10 minutes')`, [versionId, sellerId]);
  const coursePendingId = randomUUID();
  await apiPool.query(`INSERT INTO course_delivery_assets (course_delivery_asset_id, course_run_id, owner_user_id, asset_purpose,
    bucket_name, object_key, original_filename, declared_content_type, declared_byte_size, upload_expires_at)
    VALUES ($1, $2, $3, 'cloud_download', 'local-test-only', 'fixture/course-quota.pdf', 'course-quota.pdf', 'application/pdf', 100, now() + interval '10 minutes')`,
  [coursePendingId, courseRunId, sellerId]);
  await database.withTransaction((client) => assertAccountStorageQuota(client, sellerId, 27, { maxBytes: 500, maxPendingUploads: 3 }));
  await assert.rejects(database.withTransaction((client) => assertAccountStorageQuota(client, sellerId, 28, { maxBytes: 500, maxPendingUploads: 3 })),
    (error) => error.code === 'CONTENT_STORAGE_QUOTA_EXCEEDED');
  await assert.rejects(database.withTransaction((client) => assertAccountStorageQuota(client, sellerId, 1, { maxBytes: 500, maxPendingUploads: 2 })),
    (error) => error.code === 'CONTENT_UPLOAD_PENDING_LIMIT');
  await database.withTransaction((client) => assertAccountStorageQuota(client, buyerId, 500, { maxBytes: 500, maxPendingUploads: 3 }));
  await apiPool.query(`UPDATE course_delivery_assets SET asset_status = 'deleted', deleted_at = now(), updated_at = now()
    WHERE course_delivery_asset_id = $1`, [coursePendingId]);
  await database.withTransaction((client) => assertAccountStorageQuota(client, sellerId, 127, { maxBytes: 500, maxPendingUploads: 3 }));
  passed('shared Creator/Trainer quota SQL counts both tables and larger verified size, retains pending-deletion bytes, excludes deleted objects and isolates owners');

  const archivedContent = randomUUID(); const archivedVersion = randomUUID();
  const archivedCourse = randomUUID(); const archivedRun = randomUUID();
  await owner.query(`INSERT INTO contents (content_id, creator_user_id, title, content_type, price_points, publication_status)
    VALUES ($1, $2, 'Archived cleanup fixture', 'digital', 0, 'archived')`, [archivedContent, sellerId]);
  await owner.query(`INSERT INTO content_versions (content_version_id, content_id, version_no, version_status) VALUES ($1, $2, 1, 'retired')`, [archivedVersion, archivedContent]);
  await owner.query(`INSERT INTO courses (course_id, owner_user_id, title, publication_status)
    VALUES ($1, $2, 'Archived cleanup fixture', 'archived')`, [archivedCourse, sellerId]);
  await owner.query(`INSERT INTO course_runs (course_run_id, course_id, run_code, run_status, price_points, primary_delivery_type)
    VALUES ($1, $2, 'fixture-archived-run', 'archived', 0, 'cloud')`, [archivedRun, archivedCourse]);
  async function cleanupFixture(kind, parentId, objectKey, status = 'delete_pending', expired = true) {
    const id = randomUUID();
    const table = kind === 'content' ? 'storage_assets' : 'course_delivery_assets';
    const idColumn = kind === 'content' ? 'storage_asset_id' : 'course_delivery_asset_id';
    const parentColumn = kind === 'content' ? 'content_version_id' : 'course_run_id';
    const purpose = kind === 'content' ? 'content_primary' : 'cloud_download';
    await owner.query(`INSERT INTO ${table} (${idColumn}, ${parentColumn}, owner_user_id, asset_purpose, bucket_name, object_key,
      original_filename, declared_content_type, declared_byte_size, verified_byte_size, verified_content_type, verified_at,
      asset_status, upload_expires_at, created_at)
      VALUES ($1, $2, $3, $4, 'local-test-only', $5, 'cleanup.pdf', 'application/pdf', 100, 100, 'application/pdf', now(),
        $6, now() + ($7 * interval '1 hour'), now() - interval '2 hours')`, [id, parentId, sellerId, purpose, objectKey, status, expired ? -1 : 1]);
    return id;
  }
  const expiredContentId = await cleanupFixture('content', archivedVersion, 'fixture/cleanup-content.pdf');
  const expiredReadyId = await cleanupFixture('content', archivedVersion, 'fixture/cleanup-ready.pdf', 'ready');
  const expiredCourseId = await cleanupFixture('course', archivedRun, 'fixture/cleanup-course.pdf');
  const failedCourseId = await cleanupFixture('course', archivedRun, 'fixture/retry-course.pdf');
  const publishedAssetId = await cleanupFixture('course', courseRunId, 'fixture/keep-published.pdf', 'ready');
  const publishedTombstoneId = await cleanupFixture('course', courseRunId, 'fixture/published-tombstone.pdf');
  const primaryReferenceId = await cleanupFixture('content', versionId, 'fixture/keep-primary-reference.pdf');
  await owner.query('UPDATE content_versions SET storage_asset_id = $1 WHERE content_version_id = $2', [primaryReferenceId, versionId]);
  const futureAssetId = await cleanupFixture('content', archivedVersion, 'fixture/keep-unexpired.pdf', 'delete_pending', false);
  const activeDraftAssetId = await cleanupFixture('course', savedDraft.id, 'fixture/keep-active-draft.pdf', 'ready');
  const expectedCleanupIds = [expiredContentId, expiredReadyId, expiredCourseId, failedCourseId, publishedTombstoneId].sort();
  const candidateIds = [];
  for (const kind of ['content', 'course']) {
    const candidates = await database.withTransaction((client) => client.query(cleanupCandidateSql(kind), [[], 100]));
    candidateIds.push(...candidates.rows.map((row) => row.asset_id));
  }
  assert.deepEqual(candidateIds.sort(), expectedCleanupIds);
  const deletedObjectKeys = [];
  const cleanupResult = await reconcileStorage({
    withTransaction: database.withTransaction,
    deleteObject: async ({ objectKey }) => {
      deletedObjectKeys.push(objectKey);
      if (objectKey === 'fixture/retry-course.pdf') throw new Error('Simulated object-storage deletion failure');
    },
  });
  assert.deepEqual(cleanupResult, { removed: 4, deferred: 1, skipped: 0 });
  assert.equal(deletedObjectKeys.length, 5);
  for (const [table, idColumn, id, expectedStatus] of [
    ['storage_assets', 'storage_asset_id', expiredContentId, 'deleted'],
    ['storage_assets', 'storage_asset_id', expiredReadyId, 'deleted'],
    ['course_delivery_assets', 'course_delivery_asset_id', expiredCourseId, 'deleted'],
    ['course_delivery_assets', 'course_delivery_asset_id', failedCourseId, 'delete_pending'],
    ['course_delivery_assets', 'course_delivery_asset_id', publishedAssetId, 'ready'],
    ['course_delivery_assets', 'course_delivery_asset_id', publishedTombstoneId, 'deleted'],
    ['storage_assets', 'storage_asset_id', primaryReferenceId, 'delete_pending'],
    ['storage_assets', 'storage_asset_id', futureAssetId, 'delete_pending'],
    ['course_delivery_assets', 'course_delivery_asset_id', activeDraftAssetId, 'ready'],
  ]) {
    const stored = await apiPool.query(`SELECT asset_status FROM ${table} WHERE ${idColumn} = $1`, [id]);
    assert.equal(stored.rows[0].asset_status, expectedStatus);
  }
  passed('real runtime cleanup SQL for both asset tables; no network; archived files/tombstones removed, failed delete retryable, published ready/primary-reference/active-draft/unexpired files preserved');
  process.stdout.write(`SUCCESS ${checks} integration check groups passed; test-only data retained in disposable local PostgreSQL cluster.\n`);
} finally {
  await Promise.all([owner.end(), freshPool?.end(), apiPool?.end()]);
}
