/**
 * Opt-in HTTP pagination regression checks against a NEW, empty local PG16 DB.
 * From apps/api: node --import tsx scripts/pagination-integration-check.mjs
 * Required: RELEASE_CHECK_DATABASE_URL, naming colearnx_release_check_<unique>.
 * The entire cluster must be disposable (only release-check DBs and postgres).
 * Applies migrations 001-011 and retains all synthetic fixtures for inspection.
 * Does not create/drop databases, erase fixtures, load .env, or call cloud APIs.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { migrationChecksum } from '../src/db/migration-checksum.ts';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const rawUrl = process.env.RELEASE_CHECK_DATABASE_URL;
const date = '2026-09-13';
const dateRange = { from: date, to: date };
let owner;
let apiPool;
let stage = 'local database opt-in';
let checks = 0;
let blockedHttpCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  blockedHttpCalls += 1;
  throw new Error('External HTTP is prohibited in pagination integration checks.');
};

function passed(message) {
  checks += 1;
  process.stdout.write(`PASS ${message}\n`);
}

// Clear inherited application/cloud/PG configuration before creating any pool
// or importing the app. Keep only OS paths needed by the already-running Node.
function isolateEnvironment(databaseUrl) {
  const environment = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment, {
    NODE_ENV: 'development', DATABASE_URL: databaseUrl, DATABASE_SSL: 'false', DB_POOL_MAX: '4',
    DOTENV_CONFIG_PATH: process.platform === 'win32' ? 'NUL' : '/dev/null', DOTENV_CONFIG_QUIET: 'true',
    APP_ORIGIN: 'http://localhost:5173', API_ORIGIN: 'http://localhost:3001',
    ACCESS_TOKEN_SECRET: randomBytes(32).toString('hex'),
    REFRESH_TOKEN_SECRET: randomBytes(32).toString('hex'), CSRF_SECRET: randomBytes(32).toString('hex'),
    SECURITY_HASH_PEPPER: randomBytes(32).toString('hex'), SECURITY_ALERT_WEBHOOK_URL: '',
    PWNED_PASSWORDS_ENABLED: 'false', PWNED_PASSWORDS_API_BASE: 'http://127.0.0.1:1',
    EMAIL_PROVIDER: 'disabled', OBJECT_STORAGE_PROVIDER: 'disabled', REDIS_URL: '',
    STRIPE_MODE: 'test', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', LOG_LEVEL: 'silent',
  });
}

function encode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decode(value) { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
function displayTimestamp(value) { return value === null ? null : `${value.slice(0, 23)}Z`; }
function sorted(rows) {
  return [...rows].sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      if (left.createdAt === null) return 1;
      if (right.createdAt === null) return -1;
      return left.createdAt > right.createdAt ? -1 : 1;
    }
    return left.id > right.id ? -1 : left.id < right.id ? 1 : 0;
  });
}
let fixtureSequence = 0;
function row(createdAt, extras = {}) {
  fixtureSequence += 1;
  return { id: `10000000-0000-4000-8000-${String(fixtureSequence).padStart(12, '0')}`, createdAt, ...extras };
}

try {
  assert.ok(rawUrl, 'Set RELEASE_CHECK_DATABASE_URL to a new empty disposable LOCAL PostgreSQL 16 database.');
  const ownerUrl = new URL(rawUrl);
  const databaseName = decodeURIComponent(ownerUrl.pathname.slice(1));
  assert.ok(['postgres:', 'postgresql:'].includes(ownerUrl.protocol), 'PostgreSQL URL required.');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(ownerUrl.hostname), 'Remote databases are prohibited.');
  assert.match(databaseName, /^colearnx_release_check_[a-z0-9_]+$/, 'Use a uniquely named disposable release-check database.');
  assert.equal(ownerUrl.search, '', 'Connection URL options are prohibited.');
  assert.equal(ownerUrl.hash, '', 'Connection URL fragments are prohibited.');
  isolateEnvironment(ownerUrl.href);
  owner = new Pool({ connectionString: ownerUrl.href, ssl: false, max: 1, connectionTimeoutMillis: 5000 });
  const version = (await owner.query('SHOW server_version_num')).rows[0].server_version_num;
  assert.equal(Math.floor(Number(version) / 10000), 16, 'PostgreSQL 16 is required.');
  const connection = (await owner.query('SELECT current_database() AS name, host(inet_server_addr()) AS address')).rows[0];
  assert.equal(connection.name, databaseName, 'Connected database must match the opted-in database.');
  assert.ok(['127.0.0.1', '::1'].includes(connection.address), 'The PostgreSQL server must use a loopback address.');
  const databaseNames = async () => (await owner.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY datname")).rows.map((entry) => entry.datname);
  const databasesBefore = await databaseNames();
  assert.ok(databasesBefore.every((name) => /^colearnx_release_check_[a-z0-9_]+$/.test(name)),
    'Refusing a cluster containing non-test databases. Use a disposable local cluster.');
  const relations = await owner.query(`SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`);
  assert.equal(relations.rows[0].count, 0, 'Target database must be empty; existing fixtures will not be erased.');
  passed('opt-in empty loopback PG16 database and test-only cluster');

  stage = 'migrations 001-011';
  for (const role of ['colearnx_app', 'colearnx_migrator', 'colearnx_readonly']) {
    if (!(await owner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount) {
      // Identifiers are exclusively the three constants above.
      await owner.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    }
  }
  const privileges = (await owner.query("SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = 'colearnx_app'")).rows[0];
  assert.ok(Object.values(privileges).every((value) => value === false), 'colearnx_app must be an unprivileged runtime role.');
  const migrationDirectory = join(apiRoot, '../../db/migrations');
  const migrationFiles = (await readdir(migrationDirectory)).filter((file) => file.endsWith('.sql')).sort();
  assert.deepEqual(migrationFiles.map((file) => file.slice(0, 3)), Array.from({ length: 11 }, (_, index) => String(index + 1).padStart(3, '0')),
    'This regression fixture requires migrations 001 through 011.');
  await owner.query('CREATE TABLE schema_migrations (filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const filename of migrationFiles) {
    const sql = await readFile(join(migrationDirectory, filename), 'utf8');
    await owner.query('BEGIN');
    try {
      await owner.query(sql);
      await owner.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [filename, migrationChecksum(sql)]);
      await owner.query('COMMIT');
    } catch (error) { await owner.query('ROLLBACK'); throw error; }
  }
  passed('fresh migrations 001-011 with recorded canonical checksums');

  stage = 'runtime role and synthetic accounts';
  const adminId = randomUUID();
  const memberId = randomUUID();
  for (const [id, name] of [[adminId, 'Pagination Admin'], [memberId, 'Pagination Member']]) {
    await owner.query("INSERT INTO users (user_id, full_name, email, password_hash) VALUES ($1, $2, $3, 'synthetic-not-a-login-hash')",
      [id, name, `${id}@example.test`]);
  }
  await owner.query("INSERT INTO roles (role_code, role_name, description) VALUES ('admin', 'Admin', 'Pagination fixture'), ('member', 'Member', 'Pagination fixture')");
  for (const [id, role] of [[adminId, 'admin'], [memberId, 'member']]) {
    await owner.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, role_id FROM roles WHERE role_code = $2', [id, role]);
  }
  const runtimeUrl = new URL(ownerUrl.href);
  runtimeUrl.searchParams.set('options', '-c role=colearnx_app -c timezone=Asia/Shanghai');
  // A non-UTC session also checks that cursor formatting explicitly uses UTC.
  process.env.DATABASE_URL = runtimeUrl.href;
  apiPool = (await import('../src/db/database.ts')).pool;
  assert.equal((await apiPool.query('SELECT current_user')).rows[0].current_user, 'colearnx_app');
  assert.equal((await apiPool.query('SHOW timezone')).rows[0].TimeZone, 'Asia/Shanghai');
  await assert.rejects(apiPool.query('SELECT * FROM schema_migrations'), (error) => error.code === '42501');
  const { createApp } = await import('../src/app.ts');
  const app = createApp();
  const adminToken = jwt.sign({ sub: adminId }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '10m' });
  const memberToken = jwt.sign({ sub: memberId }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '10m' });
  const reportsPath = '/api/v1/admin/reports';
  const auditPath = '/api/v1/admin/audit-logs';
  async function get(path, query, expectedStatus = 200, token = adminToken) {
    const pending = request(app).get(path).query(query).timeout({ response: 5000, deadline: 10000 });
    if (token) pending.set('Authorization', `Bearer ${token}`);
    const response = await pending;
    assert.equal(response.status, expectedStatus, `${stage}: ${path} HTTP status (error ${response.body?.error?.code ?? 'none'})`);
    return response.body;
  }
  async function badCursor(path, query, cursor, code = 'VALIDATION_ERROR') {
    const body = await get(path, { ...query, cursor }, 400);
    assert.equal(body.error.code, code, `${stage}: expected ${code}`);
  }
  async function scan(path, query, fixtures, limit) {
    const expected = sorted(fixtures);
    const observed = [];
    const pageSizes = [];
    let cursor;
    let firstPage;
    do {
      const body = await get(path, { ...query, limit, ...(cursor ? { cursor } : {}) });
      firstPage ??= body;
      assert.ok(Array.isArray(body.data), `${stage}: data must be an array`);
      const page = expected.slice(observed.length, observed.length + limit);
      assert.deepEqual(body.data.map((entry) => entry.id), page.map((entry) => entry.id), `${stage}: exact page IDs and order at offset ${observed.length}`);
      body.data.forEach((entry, index) => {
        assert.equal(entry.createdAt, displayTimestamp(page[index].createdAt), `${stage}: display timestamp retains milliseconds/null`);
        assert.equal(Object.hasOwn(entry, 'cursor_created_at'), false, 'Internal cursor timestamp must not leak into the DTO.');
        if (path === reportsPath) assert.equal(entry.status, query.status, 'Report status filter must be preserved.');
      });
      observed.push(...body.data.map((entry) => entry.id));
      pageSizes.push(body.data.length);
      const hasNext = observed.length < expected.length;
      assert.equal(body.meta.hasNext, hasNext, `${stage}: hasNext reflects an actual remaining row`);
      if (hasNext) {
        assert.equal(typeof body.meta.nextCursor, 'string', 'Nonfinal page needs a cursor.');
        const boundary = page.at(-1);
        const parsed = decode(body.meta.nextCursor);
        assert.equal(parsed.v, 2, 'New cursor version must be 2.');
        assert.equal(parsed.id, boundary.id, 'Cursor must use the last returned row, not the lookahead row.');
        assert.equal(parsed.createdAt, boundary.createdAt, 'Cursor must retain the original six microsecond digits/null.');
        if (parsed.createdAt !== null) assert.match(parsed.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
        if (path === reportsPath) assert.equal(parsed.status, query.status);
        else {
          const filter = createHash('sha256').update(JSON.stringify({ from: query.from, to: query.to, search: query.search })).digest('hex');
          assert.equal(parsed.filter, filter, 'Audit cursor must bind its date/search filters.');
        }
      } else assert.equal(body.meta.nextCursor, null, 'Final/empty page must not emit a cursor.');
      cursor = body.meta.nextCursor;
      assert.ok(pageSizes.length <= expected.length + 1, 'Pagination must terminate.');
    } while (cursor);
    assert.equal(new Set(observed).size, observed.length, 'Pagination must never repeat a row.');
    assert.deepEqual(observed, expected.map((entry) => entry.id), 'All fixture rows must appear exactly once in order.');
    return { firstPage, pageSizes };
  }
  async function insertReports(fixtures) {
    await owner.query(`INSERT INTO user_reports
      (report_id, reporter_user_id, target_user_id, reason, report_category, report_status, created_at, reviewer_user_id, reviewed_at, decision_reason)
      SELECT f.id, $2::uuid, $3::uuid, 'Synthetic pagination regression fixture.', 'other', f.status, f."createdAt",
        CASE WHEN f.status <> 'pending' THEN $3::uuid END,
        CASE WHEN f.status <> 'pending' THEN '2026-09-18T00:00:00Z'::timestamptz END,
        CASE WHEN f.status <> 'pending' THEN 'Synthetic completed report fixture.' END
      FROM jsonb_to_recordset($1::jsonb) AS f(id uuid, "createdAt" timestamptz, status text)`, [JSON.stringify(fixtures), memberId, adminId]);
  }
  async function insertAudit(fixtures) {
    await owner.query(`INSERT INTO admin_action_logs (log_id, actor_user_id, action_type, target_table, target_record_id, created_at)
      SELECT f.id, $2::uuid, f.action, 'pagination_fixture', f.id::text, f."createdAt"
      FROM jsonb_to_recordset($1::jsonb) AS f(id uuid, "createdAt" timestamptz, action text)`, [JSON.stringify(fixtures), adminId]);
  }

  stage = 'authorization';
  for (const path of [reportsPath, auditPath]) {
    await get(path, {}, 401, null);
    await get(path, {}, 403, memberToken);
  }
  passed('actual Express HTTP uses colearnx_app; both endpoints enforce 401/403');

  stage = 'reports empty and exact microsecond ties';
  await scan(reportsPath, { status: 'pending' }, [], 1);
  const pendingReports = [row(`${date}T01:02:03.123456Z`, { status: 'pending' }), row(`${date}T01:02:03.123456Z`, { status: 'pending' })];
  await insertReports(pendingReports);
  const reportFirst = (await scan(reportsPath, { status: 'pending' }, pendingReports, 1)).firstPage;
  assert.deepEqual((await scan(reportsPath, { status: 'pending' }, pendingReports, 2)).pageSizes, [2]);
  assert.deepEqual((await scan(reportsPath, { status: 'pending' }, pendingReports, 3)).pageSizes, [2]);
  passed('reports empty, N+1 and exact-N pages; identical .123456 rows paginate at limit 1');

  stage = 'reports mixed precision and legacy null timestamps';
  const mixedReports = [
    row(`${date}T01:02:04.123999Z`, { status: 'pending' }), row(`${date}T01:02:04.123001Z`, { status: 'pending' }),
    row(`${date}T01:02:05.456000Z`, { status: 'pending' }),
    ...Array.from({ length: 3 }, () => row(null, { status: 'pending' })),
  ];
  await insertReports(mixedReports);
  pendingReports.push(...mixedReports);
  await scan(reportsPath, { status: 'pending' }, pendingReports, 1);
  await scan(reportsPath, { status: 'pending' }, pendingReports, 3);
  const dismissedReports = Array.from({ length: 3 }, () => row(null, { status: 'dismissed' }));
  await insertReports(dismissedReports);
  const nullFirst = (await scan(reportsPath, { status: 'dismissed' }, dismissedReports, 1)).firstPage;
  passed('reports distinct microseconds in one millisecond, millisecond dates, NULL-only and non-NULL to NULL pages');

  stage = 'reports 101-row tie';
  await scan(reportsPath, { status: 'resolved' }, [], 100);
  const resolvedReports = Array.from({ length: 101 }, () => row(`${date}T01:02:03.123456Z`, { status: 'resolved' }));
  await insertReports(resolvedReports);
  assert.deepEqual((await scan(reportsPath, { status: 'resolved' }, resolvedReports, 100)).pageSizes, [100, 1]);
  await scan(reportsPath, { status: 'resolved' }, resolvedReports, 17);
  passed('reports 101 equal timestamps return 100+1 and seven complete ordered pages; statuses remain isolated');

  stage = 'audit empty and exact microsecond ties';
  await scan(auditPath, { ...dateRange, search: 'pagination.empty' }, [], 1);
  const equalAudit = Array.from({ length: 2 }, () => row(`${date}T01:02:03.123456Z`, { action: 'pagination.equal' }));
  await insertAudit(equalAudit);
  const auditQuery = { ...dateRange, search: 'pagination.equal' };
  const auditFirst = (await scan(auditPath, auditQuery, equalAudit, 1)).firstPage;
  assert.deepEqual((await scan(auditPath, auditQuery, equalAudit, 2)).pageSizes, [2]);
  assert.deepEqual((await scan(auditPath, auditQuery, equalAudit, 3)).pageSizes, [2]);
  passed('audit empty, N+1 and exact-N pages; identical .123456 rows paginate at limit 1');

  stage = 'audit mixed precision and 101-row tie';
  const mixedAudit = [
    row(`${date}T01:02:04.123999Z`, { action: 'pagination.mixed' }), row(`${date}T01:02:04.123001Z`, { action: 'pagination.mixed' }),
    row(`${date}T01:02:05.456000Z`, { action: 'pagination.mixed' }),
  ];
  const largeAudit = Array.from({ length: 101 }, () => row(`${date}T01:02:03.123456Z`, { action: 'pagination.large' }));
  await insertAudit([...mixedAudit, ...largeAudit]);
  await scan(auditPath, { ...dateRange, search: 'pagination.mixed' }, mixedAudit, 1);
  assert.deepEqual((await scan(auditPath, { ...dateRange, search: 'pagination.large' }, largeAudit, 100)).pageSizes, [100, 1]);
  await scan(auditPath, { ...dateRange, search: 'pagination.large' }, largeAudit, 17);
  passed('audit same-millisecond distinct microseconds, millisecond dates, 101-row 100+1 and complete multipage order');

  stage = 'audit literal search and UTC date boundaries';
  const literal = 'pagination.literal%_\\end';
  const inRange = [row(`${date}T00:00:00.000000Z`, { action: literal }), row(`${date}T23:59:59.999999Z`, { action: literal })];
  await insertAudit([
    ...inRange,
    row('2026-09-12T23:59:59.999999Z', { action: literal }), row('2026-09-14T00:00:00.000000Z', { action: literal }),
    row(`${date}T12:00:00.000000Z`, { action: 'pagination.literalXYZend' }),
    row(`${date}T12:00:00.000000Z`, { action: 'pagination.literal%X\\end' }),
  ]);
  await scan(auditPath, { ...dateRange, search: literal.toUpperCase() }, inRange, 1);
  passed('audit literal %, _, backslash and case-insensitive search; inclusive UTC days exclude adjacent dates');

  stage = 'cursor validation, bindings and v1 restart policy';
  for (const [path, query, first] of [[reportsPath, { status: 'pending' }, reportFirst], [auditPath, auditQuery, auditFirst]]) {
    const valid = decode(first.meta.nextCursor);
    const invalidValues = [
      'not-a-cursor', encode(null), encode({}),
      ...[
        { v: 99 }, { id: 'not-a-uuid' }, { createdAt: 'infinity' }, { createdAt: 123 },
        { createdAt: '2026-02-30T01:02:03.123456Z' }, { createdAt: '2026-09-13T01:02:03.123456' },
        { createdAt: '2026-09-13T01:02:03.123Z' }, { v: 1 },
      ].map((change) => encode({ ...valid, ...change })),
    ];
    for (const invalid of invalidValues) await badCursor(path, query, invalid);
    await badCursor(path, query, encode({ ...valid, v: 1, createdAt: displayTimestamp(valid.createdAt) }), 'CURSOR_RESTART_REQUIRED');
    await get(path, { ...query, cursor: first.meta.nextCursor, page: 1 }, 400);
  }
  await badCursor(reportsPath, { status: 'resolved' }, reportFirst.meta.nextCursor);
  await badCursor(reportsPath, { status: 'dismissed' }, encode({ ...decode(nullFirst.meta.nextCursor), v: 1 }), 'CURSOR_RESTART_REQUIRED');
  await badCursor(auditPath, auditQuery, encode({ ...decode(auditFirst.meta.nextCursor), v: 1, createdAt: null }));
  for (const change of [{ search: 'pagination.mixed' }, { from: '2026-09-12' }, { to: '2026-09-14' }]) {
    await badCursor(auditPath, { ...auditQuery, ...change }, auditFirst.meta.nextCursor);
  }
  passed('both endpoints reject malformed/wrong-version/filter-mismatched cursors; valid v1 returns CURSOR_RESTART_REQUIRED, including report NULL');

  stage = 'fixture preservation and no external HTTP';
  assert.equal((await owner.query('SELECT count(*)::int AS count FROM user_reports')).rows[0].count,
    pendingReports.length + dismissedReports.length + resolvedReports.length);
  assert.equal((await owner.query('SELECT count(*)::int AS count FROM admin_action_logs')).rows[0].count,
    equalAudit.length + mixedAudit.length + largeAudit.length + 6);
  assert.deepEqual(await databaseNames(), databasesBefore, 'Prior databases must remain present; no database is created or removed.');
  assert.equal(blockedHttpCalls, 0, 'No external HTTP request may be attempted.');
  passed('all synthetic rows and prior fixture databases retained; zero external HTTP attempts');
  process.stdout.write(`SUCCESS ${checks} pagination integration groups passed; synthetic data retained in the opted-in local database.\n`);
} catch (error) {
  // Avoid printing connection objects, URLs, environment values or full stacks.
  const detail = error instanceof assert.AssertionError ? error.message.split('\n')[0] :
    `operation failed${typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? ` (${error.code})` : ''}`;
  process.stderr.write(`FAIL ${stage}: ${detail}\n`);
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  const closed = await Promise.allSettled([owner?.end(), apiPool?.end()]);
  if (closed.some((result) => result.status === 'rejected')) {
    process.stderr.write('FAIL database connection cleanup.\n');
    process.exitCode = 1;
  }
}
