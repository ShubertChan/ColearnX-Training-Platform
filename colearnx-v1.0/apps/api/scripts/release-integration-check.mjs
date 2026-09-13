/**
 * Opt-in PostgreSQL 16 release checks. Never run against staging/production.
 * Start a NEW disposable local PostgreSQL container and provide its empty DB as
 * RELEASE_CHECK_DATABASE_URL. The DB name must start colearnx_release_check_.
 * Run from apps/api: node --import tsx scripts/release-integration-check.mjs
 * No cloud credentials, seed, restore, DROP, or external email/payment/storage
 * calls are used. Test rows/databases are left in the disposable container.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
let blockedHttpCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { blockedHttpCalls += 1; throw new Error('External HTTP is prohibited in release integration checks.'); };
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
    DB_POOL_MAX: '10',
    DOTENV_CONFIG_PATH: join(apiRoot, 'scripts', '__release_check_no_dotenv__'),
    APP_ORIGIN: 'http://localhost:5173',
    API_ORIGIN: 'http://localhost:3001',
    ACCESS_TOKEN_SECRET: randomBytes(32).toString('hex'),
    REFRESH_TOKEN_SECRET: randomBytes(32).toString('hex'),
    CSRF_SECRET: randomBytes(32).toString('hex'),
    SECURITY_HASH_PEPPER: randomBytes(32).toString('hex'),
    SECURITY_ALERT_WEBHOOK_URL: '',
    SECURITY_EVENT_RETENTION_DAYS: '180',
    PWNED_PASSWORDS_ENABLED: 'false',
    PWNED_PASSWORDS_API_BASE: 'http://127.0.0.1:1',
    PASSWORD_RESET_COOLDOWN_SECONDS: '60',
    REDIS_URL: '',
    EMAIL_PROVIDER: 'disabled',
    OBJECT_STORAGE_PROVIDER: 'disabled',
    STRIPE_MODE: 'test',
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    LOG_LEVEL: 'silent',
  };
}

async function ownerCommand(script, databaseUrl, extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: apiRoot, env: { ...testEnvironment(databaseUrl), ...extraEnvironment }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (value) => { stdout += value; });
    child.stderr.on('data', (value) => { stderr += value; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

async function migrate(databaseUrl) {
  const output = await ownerCommand('src/db/migrate.ts', databaseUrl);
  assert.equal(output.code, 0, `Migration failed: ${output.stderr}`);
  return output.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
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
  assert.deepEqual(migrationFiles.map((file) => file.slice(0, 3)),
    Array.from({ length: migrationFiles.length }, (_, index) => String(index + 1).padStart(3, '0')));
  // Keep the pre-008 cart fixture so forward upgrades retain legacy prices.
  const baselineCount = 7;
  assert.ok(migrationFiles.length >= 10, 'Security-release migrations 009 and 010 must be present.');
  const connection = await owner.connect();
  try {
    for (const filename of migrationFiles.slice(0, baselineCount)) {
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
  assert.deepEqual(await migrate(ownerUrl.href), migrationFiles.slice(baselineCount).map((file) => `Applied ${file}`));
  for (const snapshot of oldSnapshot) {
    if (snapshot.sql.includes('"schema_migrations"')) continue;
    const rows = await owner.query(snapshot.sql);
    assert.deepEqual(rows.rows.map((row) => JSON.stringify(row)).sort(), snapshot.rows, `Existing rows changed: ${snapshot.sql}`);
  }
  const ledgerAfter = await owner.query('SELECT * FROM schema_migrations ORDER BY filename');
  assert.equal(ledgerAfter.rowCount, migrationFiles.length);
  assert.deepEqual(ledgerAfter.rows.slice(0, baselineCount), ledgerBefore.rows);
  assert.equal((await owner.query('SELECT count(*)::int AS count FROM users WHERE password_changed_at IS NOT NULL')).rows[0].count, 0);
  passed('all forward migrations through the real runner preserve existing rows and migration records; legacy passwords remain grandfathered');
  assert.deepEqual(await migrate(ownerUrl.href), []);
  assert.deepEqual((await owner.query('SELECT * FROM schema_migrations ORDER BY filename')).rows, ledgerAfter.rows);
  passed('second migration invocation is a no-op, including applied timestamps/checksums');

  const freshName = `${dbName}_fresh`;
  await owner.query(`CREATE DATABASE ${quoteIdentifier(freshName)}`);
  const freshUrl = new URL(ownerUrl.href); freshUrl.pathname = `/${freshName}`;
  assert.deepEqual(await migrate(freshUrl.href), migrationFiles.map((file) => `Applied ${file}`));
  freshPool = new Pool({ connectionString: freshUrl.href, max: 1 });
  assert.equal((await freshPool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count, migrationFiles.length);
  passed(`complete fresh installation through all ${migrationFiles.length} migrations using the real runner`);

  // A dedicated pool defaults every connection to SET ROLE colearnx_app. The
  // SQL checks therefore exercise the real runtime role's object privileges.
  const runtimeUrl = new URL(ownerUrl.href);
  runtimeUrl.searchParams.set('options', '-c role=colearnx_app');
  const environment = testEnvironment(runtimeUrl.href);
  for (const key of Object.keys(process.env)) {
    if (/^(DATABASE_|MIGRATION_|STRIPE_|R2_|RESEND_|EMAIL_|OBJECT_STORAGE_|ENABLE_|COOKIE_|SECURITY_|PWNED_|PASSWORD_|LOGIN_|REDIS_|APP_ORIGIN|API_ORIGIN|NODE_ENV|DOTENV_|.*_TOKEN_SECRET|CSRF_SECRET|LOG_LEVEL)/.test(key)) delete process.env[key];
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

  await apiPool.query("INSERT INTO security_events (event_type, severity, actor_user_id) VALUES ('auth.login_failed', 1, $1)", [buyerId]);
  await apiPool.query('SELECT * FROM security_events LIMIT 1');
  for (const sql of ['UPDATE security_events SET severity = severity', 'DELETE FROM security_events', 'TRUNCATE security_events']) {
    await assert.rejects(apiPool.query(sql), (error) => error.code === '42501');
  }
  await apiPool.query('INSERT INTO auth_failure_counters (user_id) VALUES ($1)', [buyerId]);
  await apiPool.query('UPDATE auth_failure_counters SET consecutive_failures = 1 WHERE user_id = $1', [buyerId]);
  await apiPool.query('SELECT * FROM auth_failure_counters WHERE user_id = $1', [buyerId]);
  await apiPool.query('DELETE FROM auth_failure_counters WHERE user_id = $1', [buyerId]);
  await apiPool.query('UPDATE users SET password_changed_at = now() WHERE user_id = $1', [buyerId]);
  for (const role of ['colearnx_readonly', 'colearnx_migrator']) {
    const roleUrl = new URL(ownerUrl.href); roleUrl.searchParams.set('options', `-c role=${role}`);
    const rolePool = new Pool({ connectionString: roleUrl.href, max: 1 });
    try {
      for (const table of ['security_events', 'auth_failure_counters']) {
        await assert.rejects(rolePool.query(`SELECT * FROM ${table}`), (error) => error.code === '42501');
      }
    } finally { await rolePool.end(); }
  }
  passed('009/010 runtime telemetry is append-only, counter CRUD/password timestamp updates work, and legacy roles cannot read security data');

  const { registerFailure, clearFailures } = await import('../src/auth/lockout.ts');
  const connectNormally = apiPool.connect.bind(apiPool);
  let emptyReads = 0; let releaseEmptyReads;
  const emptyReadBarrier = new Promise((resolve) => { releaseEmptyReads = resolve; });
  // Only synchronize absent-row reads. The previous implementation reaches
  // this barrier five times and loses four increments; the fixed initializer
  // always reads an existing locked row, so it needs no artificial scheduling.
  apiPool.connect = async (...args) => {
    const client = await connectNormally(...args);
    const queryNormally = client.query; const releaseNormally = client.release;
    client.query = async (...queryArgs) => {
      const result = await queryNormally.apply(client, queryArgs);
      if (typeof queryArgs[0] === 'string' && /FROM auth_failure_counters WHERE user_id = \$1 FOR UPDATE/.test(queryArgs[0]) && result.rowCount === 0) {
        emptyReads += 1; if (emptyReads === 5) releaseEmptyReads();
        await emptyReadBarrier;
      }
      return result;
    };
    client.release = (...args) => {
      client.query = queryNormally; client.release = releaseNormally;
      return releaseNormally.apply(client, args);
    };
    return client;
  };
  let concurrentFailures;
  try { concurrentFailures = await Promise.all(Array.from({ length: 5 }, () => registerFailure(buyerId, 43200))); }
  finally { releaseEmptyReads(); apiPool.connect = connectNormally; }
  assert.deepEqual(concurrentFailures.map((result) => result.consecutiveFailures).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  const lockedCounter = (await owner.query('SELECT consecutive_failures, locked_until, lockout_count FROM auth_failure_counters WHERE user_id = $1', [buyerId])).rows[0];
  assert.equal(lockedCounter.consecutive_failures, 5); assert.equal(lockedCounter.lockout_count, 1);
  assert.ok(lockedCounter.locked_until > new Date());
  await clearFailures(buyerId);
  const clearedCounter = (await owner.query('SELECT consecutive_failures, locked_until, lockout_count FROM auth_failure_counters WHERE user_id = $1', [buyerId])).rows[0];
  assert.deepEqual(clearedCounter, { consecutive_failures: 0, locked_until: null, lockout_count: 1 });
  await owner.query("UPDATE auth_failure_counters SET consecutive_failures = 4, last_failure_at = now() - interval '13 hours' WHERE user_id = $1", [buyerId]);
  assert.equal((await registerFailure(buyerId, 43200)).consecutiveFailures, 1);
  passed('five concurrent first failures are counted exactly once each and trigger one lock; clearing/decay preserve lifetime history');

  const { createApp } = await import('../src/app.ts');
  const app = createApp();

  const resetSubjects = [
    { label: 'legacy', id: randomUUID(), verified: false, required: false, status: 'active', issued: true },
    { label: 'verified', id: randomUUID(), verified: true, required: true, status: 'active', issued: true },
    { label: 'pending', id: randomUUID(), verified: false, required: true, status: 'active', issued: false },
    { label: 'suspended', id: randomUUID(), verified: true, required: true, status: 'suspended', issued: false },
  ];
  const resetResponses = [];
  for (const [index, subject] of resetSubjects.entries()) {
    await owner.query(`INSERT INTO users (user_id, full_name, email, password_hash, email_verified_at, email_verification_required_at, account_status)
      VALUES ($1, $2, $3, 'fixture-not-a-login-hash', CASE WHEN $4 THEN now() END, CASE WHEN $5 THEN now() END, $6)`,
    [subject.id, subject.label, `${subject.label}@example.test`, subject.verified, subject.required, subject.status]);
    const response = await request(app).post('/api/v1/auth/forgot-password').set('X-Forwarded-For', `192.0.2.${index + 1}`)
      .send({ email: `${subject.label}@example.test` }).expect(202);
    resetResponses.push(response.body.data);
    const challenges = await owner.query('SELECT consumed_at FROM password_reset_challenges WHERE user_id = $1', [subject.id]);
    assert.equal(challenges.rowCount, subject.issued ? 1 : 0, `Reset eligibility changed for ${subject.label}`);
    // Disabled mail deliberately fails delivery without HTTP; the issued
    // challenge must be consumed, while its row proves the recovery branch ran.
    if (subject.issued) assert.ok(challenges.rows[0].consumed_at);
  }
  resetResponses.push((await request(app).post('/api/v1/auth/forgot-password').set('X-Forwarded-For', '192.0.2.10')
    .send({ email: 'unknown@example.test' }).expect(202)).body.data);
  resetResponses.push((await request(app).post('/api/v1/auth/forgot-password').set('X-Forwarded-For', '192.0.2.11')
    .send({ email: 'legacy@example.test' }).expect(202)).body.data);
  assert.ok(resetResponses.every((body) => JSON.stringify(body) === JSON.stringify({ accepted: true })));
  assert.equal((await owner.query('SELECT count(*)::int AS count FROM password_reset_challenges WHERE user_id = $1', [resetSubjects[0].id])).rows[0].count, 1);
  assert.equal((await owner.query("SELECT count(*)::int AS count FROM security_events WHERE actor_user_id = $1 AND event_type = 'auth.reset_throttled'", [resetSubjects[0].id])).rows[0].count, 1);
  passed('real forgot-password HTTP permits legacy/verified recovery, excludes pending/inactive/unknown accounts, preserves cooldown and generic 202, and performs no email request');

  const recoveringUserId = resetSubjects[0].id;
  const resetToken = randomBytes(32).toString('hex');
  const resetTokenHash = createHash('sha256').update(resetToken).digest('hex');
  const newPassword = 'Copper-lanterns-drift-beyond-velvet-947!';
  await owner.query(`INSERT INTO password_reset_challenges (user_id, token_hash, expires_at)
    VALUES ($1, $2, now() + interval '30 minutes')`, [recoveringUserId, resetTokenHash]);
  const activeSessionId = randomUUID(); const priorSessionId = randomUUID();
  await owner.query(`INSERT INTO refresh_sessions (session_id, user_id, token_hash, expires_at, revoked_at, revoke_reason)
    VALUES ($1, $2, $3, now() + interval '1 day', NULL, NULL),
      ($4, $2, $5, now() + interval '1 day', now(), 'fixture-prior-revocation')`,
  [activeSessionId, recoveringUserId, randomBytes(32).toString('hex'), priorSessionId, randomBytes(32).toString('hex')]);
  await owner.query(`INSERT INTO auth_failure_counters (user_id, consecutive_failures, locked_until, lockout_count)
    VALUES ($1, 5, now() + interval '1 minute', 3)`, [recoveringUserId]);
  const weakReset = await request(app).post('/api/v1/auth/reset-password').set('X-Forwarded-For', '192.0.2.20')
    .send({ token: resetToken, password: 'short', passwordConfirmation: 'short' }).expect(400);
  assert.equal(weakReset.body.error.code, 'PASSWORD_TOO_SHORT');
  assert.equal((await owner.query('SELECT consumed_at FROM password_reset_challenges WHERE token_hash = $1', [resetTokenHash])).rows[0].consumed_at, null);
  const resetResponse = await request(app).post('/api/v1/auth/reset-password').set('X-Forwarded-For', '192.0.2.20')
    .send({ token: resetToken, password: newPassword, passwordConfirmation: newPassword }).expect(200);
  assert.deepEqual(resetResponse.body.data, { reset: true, signInRequired: true });
  const recoveredUser = (await owner.query('SELECT password_hash, password_changed_at FROM users WHERE user_id = $1', [recoveringUserId])).rows[0];
  const argon2 = (await import('argon2')).default;
  assert.ok(await argon2.verify(recoveredUser.password_hash, newPassword));
  assert.ok(recoveredUser.password_changed_at);
  assert.ok((await owner.query('SELECT consumed_at FROM password_reset_challenges WHERE token_hash = $1', [resetTokenHash])).rows[0].consumed_at);
  const activeSessionAfter = (await owner.query('SELECT revoked_at, revoke_reason FROM refresh_sessions WHERE session_id = $1', [activeSessionId])).rows[0];
  assert.ok(activeSessionAfter.revoked_at); assert.equal(activeSessionAfter.revoke_reason, 'password-reset');
  assert.equal((await owner.query('SELECT revoke_reason FROM refresh_sessions WHERE session_id = $1', [priorSessionId])).rows[0].revoke_reason, 'fixture-prior-revocation');
  assert.deepEqual((await owner.query('SELECT consecutive_failures, locked_until, lockout_count FROM auth_failure_counters WHERE user_id = $1', [recoveringUserId])).rows[0],
    { consecutive_failures: 0, locked_until: null, lockout_count: 3 });
  const resetAudit = (await owner.query(`SELECT actor_user_id, target_record_id, details_json FROM admin_action_logs
    WHERE actor_user_id = $1 AND action_type = 'auth.password_reset_completed'`, [recoveringUserId])).rows;
  assert.deepEqual(resetAudit, [{ actor_user_id: recoveringUserId, target_record_id: recoveringUserId, details_json: { outcome: 'success', sessionsRevoked: 1 } }]);
  const reusedReset = await request(app).post('/api/v1/auth/reset-password').set('X-Forwarded-For', '192.0.2.20')
    .send({ token: resetToken, password: newPassword, passwordConfirmation: newPassword }).expect(400);
  assert.equal(reusedReset.body.error.code, 'PASSWORD_RESET_TOKEN_INVALID');
  passed('real password reset preserves weak-attempt token, rotates Argon2 hash/timestamp, revokes only active sessions, clears lock counters, writes audit, and rejects token reuse');
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

  const { runSecurityRetention } = await import('../src/security/retention-sweep.ts');
  const oldSecurityId = randomUUID(); const recentSecurityId = randomUUID();
  await owner.query(`INSERT INTO security_events (security_event_id, event_type, severity, occurred_at)
    VALUES ($1, 'auth.login_failed', 1, now() - interval '181 days'), ($2, 'auth.login_failed', 1, now())`,
  [oldSecurityId, recentSecurityId]);
  const retentionCases = [
    { label: 'old-consumed', requestedDaysAgo: 40, expiresDaysFromNow: -39, consumed: true, keep: false },
    { label: 'old-expired', requestedDaysAgo: 40, expiresDaysFromNow: -39, consumed: false, keep: false },
    { label: 'old-active', requestedDaysAgo: 40, expiresDaysFromNow: 1, consumed: false, keep: true },
    { label: 'recent-consumed', requestedDaysAgo: 10, expiresDaysFromNow: -9, consumed: true, keep: true },
    { label: 'recent-expired', requestedDaysAgo: 10, expiresDaysFromNow: -9, consumed: false, keep: true },
  ];
  for (const row of retentionCases) {
    row.userId = randomUUID(); row.id = randomUUID();
    await owner.query(`INSERT INTO users (user_id, full_name, email, password_hash)
      VALUES ($1, $2, $3, 'fixture-not-a-login-hash')`, [row.userId, row.label, `${row.label}@example.test`]);
    await owner.query(`INSERT INTO password_reset_challenges
      (password_reset_challenge_id, user_id, token_hash, requested_at, expires_at, consumed_at)
      VALUES ($1, $2, $3, now() - ($4 * interval '1 day'), now() + ($5 * interval '1 day'), CASE WHEN $6 THEN now() END)`,
    [row.id, row.userId, randomBytes(32).toString('hex'), row.requestedDaysAgo, row.expiresDaysFromNow, row.consumed]);
  }
  await assert.rejects(runSecurityRetention(apiPool), (error) => error.code === '42501');
  assert.equal((await owner.query('SELECT 1 FROM security_events WHERE security_event_id = $1', [oldSecurityId])).rowCount, 1);
  assert.deepEqual(await runSecurityRetention(owner), { eventsRemoved: 1, tokensRemoved: 2 });
  assert.equal((await owner.query('SELECT 1 FROM security_events WHERE security_event_id = $1', [oldSecurityId])).rowCount, 0);
  assert.equal((await owner.query('SELECT 1 FROM security_events WHERE security_event_id = $1', [recentSecurityId])).rowCount, 1);
  for (const row of retentionCases) {
    assert.equal((await owner.query('SELECT 1 FROM password_reset_challenges WHERE password_reset_challenge_id = $1', [row.id])).rowCount,
      row.keep ? 1 : 0, row.label);
  }
  assert.deepEqual(await runSecurityRetention(owner), { eventsRemoved: 0, tokensRemoved: 0 });
  passed('owner retention cleans only old security events and old consumed/expired reset challenges; active/recent records survive and runtime deletion is denied');

  const rollbackEventId = randomUUID();
  await owner.query(`INSERT INTO security_events (security_event_id, event_type, severity, occurred_at)
    VALUES ($1, 'auth.login_failed', 1, now() - interval '181 days')`, [rollbackEventId]);
  const resetRowsBeforeFailure = (await owner.query('SELECT * FROM password_reset_challenges ORDER BY password_reset_challenge_id')).rows;
  const failingOwner = {
    async connect() {
      const client = await owner.connect();
      return {
        async query(sql, values) {
          // Real PostgreSQL permission failure at deletion two. SET LOCAL is
          // scoped to this transaction and is restored automatically by rollback.
          if (sql.includes('DELETE FROM password_reset_challenges')) await client.query('SET LOCAL ROLE colearnx_readonly');
          return client.query(sql, values);
        },
        release() { client.release(); },
      };
    },
  };
  await assert.rejects(runSecurityRetention(failingOwner), (error) => error.code === '42501');
  assert.equal((await owner.query('SELECT 1 FROM security_events WHERE security_event_id = $1', [rollbackEventId])).rowCount, 1);
  assert.deepEqual((await owner.query('SELECT * FROM password_reset_challenges ORDER BY password_reset_challenge_id')).rows, resetRowsBeforeFailure);
  const invalidRetention = await ownerCommand('src/security/retention.ts', ownerUrl.href, { SECURITY_EVENT_RETENTION_DAYS: '30junk' });
  assert.equal(invalidRetention.code, 1); assert.match(invalidRetention.stderr, /integer between 30 and 730/);
  assert.equal((await owner.query('SELECT 1 FROM security_events WHERE security_event_id = $1', [rollbackEventId])).rowCount, 1);
  const retentionCommand = await ownerCommand('src/security/retention.ts', ownerUrl.href);
  assert.equal(retentionCommand.code, 0, retentionCommand.stderr);
  assert.match(retentionCommand.stdout, /removed 1 security events older than 180 days, 0 closed reset tokens/);
  passed('real second-delete failure rolls back the first deletion; CLI rejects malformed days before deletion and succeeds with the corrected schema');
  assert.equal(blockedHttpCalls, 0, 'No email, HIBP, alert, payment, or storage HTTP request may be attempted.');
  process.stdout.write(`SUCCESS ${checks} integration check groups passed; test-only data retained in disposable local PostgreSQL cluster.\n`);
} finally {
  globalThis.fetch = originalFetch;
  await Promise.all([owner.end(), freshPool?.end(), apiPool?.end()]);
}
