import assert from 'node:assert/strict';
import test from 'node:test';
import { compareMigrationLedger, readCloudDatabaseConfig, verifyCloudMigrations } from './cloud-migrations.mjs';
import { sha256 } from './artifact.mjs';

const commit = 'a'.repeat(40);
const sqlByFilename = { '001_fixture.sql': 'SELECT 1;\n', '002_fixture.sql': 'SELECT 2;\n' };
const inventory = Object.entries(sqlByFilename).map(([filename, sql]) => ({ filename, checksum: sha256(sql) }));
const ledger = inventory.map(row => ({ ...row, applied_at: '2026-10-01T00:00:00.000Z' }));
const env = { STAGING_DATABASE_HOST: 'ep-synthetic-only.ap-southeast-1.aws.neon.tech',
  STAGING_DATABASE_READONLY_URL: 'postgresql://colearnx_release_reader:synthetic-password@ep-synthetic-only.ap-southeast-1.aws.neon.tech/colearnx?sslmode=require&channel_binding=require' };
const config = readCloudDatabaseConfig(env);
const identity = { database: 'colearnx', role: 'colearnx_release_reader', session_role: 'colearnx_release_reader', read_only: 'on', default_read_only: 'on', tls: true,
  rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolreplication: false, rolbypassrls: false, memberships: false,
  database_create: false, schema_create: false, table_write: false, sequence_write: false };
function fixture(overrides = {}) {
  const queries = [];
  let ended = false;
  const client = { connection: { stream: { encrypted: true, authorized: true } },
    connectionParameters: { host: config.host },
    connect: async () => {}, end: async () => { ended = true; }, query: async (sql) => {
    queries.push(sql);
    if (sql.startsWith('SELECT current_database')) return { rows: [overrides.identity ?? identity] };
    if (sql.startsWith('SELECT filename')) return { rows: overrides.ledger ?? ledger };
    return { rows: [] };
  }, ...overrides.client };
  return { queries, get ended() { return ended; }, run: (options = {}) => verifyCloudMigrations({ config, inventory, sqlByFilename, commit,
    approved: 'true', lastApplied: inventory.at(-1).filename, clientFactory: async () => client, ...options }) };
}

test('cloud credentials pin direct Neon host, role and database without URL overrides or disabling TLS', () => {
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.ssl.servername, env.STAGING_DATABASE_HOST);
  assert.equal(config.connectionTimeoutMillis, 10000);
  assert.equal(config.query_timeout, 10000);
  assert.equal(config.statement_timeout, 5000);
  assert.equal(config.connectionString, undefined);
  assert.equal(config.password, 'synthetic-password');
  for (const replacement of [undefined, 'not-a-url', env.STAGING_DATABASE_READONLY_URL.replace('colearnx_release_reader', 'neondb_owner'),
    env.STAGING_DATABASE_READONLY_URL.replace('/colearnx?', '/other?'), env.STAGING_DATABASE_READONLY_URL.replace('ep-synthetic-only.', 'ep-another.'),
    env.STAGING_DATABASE_READONLY_URL + '&options=unsafe', env.STAGING_DATABASE_READONLY_URL.replace('sslmode=require', 'sslmode=disable'),
    env.STAGING_DATABASE_READONLY_URL + '&sslmode=require', env.STAGING_DATABASE_READONLY_URL + '#fragment']) {
    assert.throws(() => readCloudDatabaseConfig({ ...env, STAGING_DATABASE_READONLY_URL: replacement }), error => !error.message.includes('synthetic-password'));
  }
  for (const host of ['', '127.0.0.1', 'example.com', 'ep-synthetic-pooler.aws.neon.tech']) assert.throws(() => readCloudDatabaseConfig({ ...env, STAGING_DATABASE_HOST: host }));
});

test('ledger compares every ordered filename, checksum and applied timestamp, not only the last row', () => {
  const result = compareMigrationLedger(inventory, [...ledger].reverse(), sqlByFilename);
  assert.equal(result.migrationCount, 2);
  assert.equal(result.lastAppliedMigration, '002_fixture.sql');
  assert.match(result.ledgerDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.ledgerDigest, compareMigrationLedger(inventory, ledger, sqlByFilename).ledgerDigest);
  for (const rows of [[], ledger.slice(1), [...ledger, ledger[0]], [ledger[0], ledger[0]],
    [{ ...ledger[0], checksum: 'f'.repeat(64) }, ledger[1]], [{ ...ledger[0], applied_at: null }, ledger[1]],
    [{ ...ledger[0], filename: '001_renamed.sql' }, ledger[1]]]) assert.throws(() => compareMigrationLedger(inventory, rows, sqlByFilename));
});

test('CRLF and narrow historical checksum compatibility reuse the migrator implementation', () => {
  const crlf = ledger.map(row => ({ ...row, checksum: sha256(sqlByFilename[row.filename].replace(/\n/g, '\r\n')) }));
  assert.equal(compareMigrationLedger(inventory, crlf, sqlByFilename).migrationCount, 2);
  assert.throws(() => compareMigrationLedger(inventory, ledger, { ...sqlByFilename, '001_fixture.sql': 'SELECT 99;\n' }), /checked-in/);
  assert.throws(() => compareMigrationLedger([inventory[0], { ...inventory[1], filename: '003_gap.sql' }], ledger, sqlByFilename), /checked-in/);
});

test('ledger evidence preserves PostgreSQL microseconds rather than truncating applied_at to JavaScript milliseconds', () => {
  const first = [{ ...ledger[0], applied_at: '2026-10-01T00:00:00.123001Z' }, ledger[1]];
  const second = [{ ...ledger[0], applied_at: '2026-10-01T00:00:00.123002Z' }, ledger[1]];
  assert.notEqual(compareMigrationLedger(inventory, first, sqlByFilename).ledgerDigest,
    compareMigrationLedger(inventory, second, sqlByFilename).ledgerDigest);
});

test('preflight uses a read-only snapshot, checks identity first and always rolls back/closes', async () => {
  const f = fixture();
  const report = await f.run();
  assert.equal(report.result, 'verified');
  assert.equal(report.migrationCount, 2);
  assert.equal(report.commit, commit);
  assert.deepEqual(report.transport, { mode: 'verified-tls', encrypted: true, certificateAuthorized: true, backendPgStatSsl: true });
  assert.equal(f.queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(f.queries.at(-1), 'ROLLBACK');
  assert.ok(f.queries.includes('SET LOCAL search_path = pg_catalog'));
  assert.ok(f.queries.find(sql => sql.startsWith('SELECT filename')).includes('public.schema_migrations'));
  assert.equal(f.ended, true);
  assert.ok(!JSON.stringify(report).includes('synthetic-password'));
  assert.ok(f.queries.every(sql => /^(?:BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/.test(sql)));
});

test('manual approval and repository checksum validation cannot be bypassed by an otherwise matching cloud', async () => {
  for (const options of [{ approved: 'false' }, { lastApplied: '001_fixture.sql' }, { commit: 'short' }, { sqlByFilename: {} }]) {
    const f = fixture();
    await assert.rejects(f.run({ ...options, clientFactory: () => assert.fail('No connection before approval/input validation') }));
    assert.equal(f.queries.length, 0);
  }
});

test('verified client TLS succeeds through a proxy whose PostgreSQL backend reports no SSL', async () => {
  const f = fixture({ identity: { ...identity, tls: false } });
  const report = await f.run();
  assert.equal(report.result, 'verified');
  assert.deepEqual(report.transport, { mode: 'verified-tls', encrypted: true, certificateAuthorized: true, backendPgStatSsl: false });
  assert.equal(f.queries.at(-1), 'ROLLBACK');
  assert.equal(f.ended, true);
});

for (const [label, connection] of [
  ['missing connection', undefined], ['missing socket', {}],
  ['plaintext socket', { stream: { encrypted: false, authorized: true } }],
  ['unverified certificate', { stream: { encrypted: true, authorized: false } }],
  ['missing certificate verdict', { stream: { encrypted: true } }],
  ['authorization error', { stream: { encrypted: true, authorized: true, authorizationError: 'sensitive certificate error' } }],
]) {
  test(`backend SSL cannot substitute for verified client transport: ${label}`, async () => {
    const f = fixture({ client: { connection } });
    await assert.rejects(f.run(), error => /must use verified TLS/.test(error.message)
      && !error.message.includes('sensitive certificate error'));
    assert.deepEqual(f.queries, []);
    assert.equal(f.ended, true);
  });
}

test('disabled certificate validation and mismatched SNI fail before the first SQL query', async () => {
  for (const ssl of [undefined, { ...config.ssl, rejectUnauthorized: false }, { ...config.ssl, servername: 'wrong.example' }]) {
    const f = fixture();
    await assert.rejects(f.run({ config: { ...config, ssl } }), /must use verified TLS/);
    assert.deepEqual(f.queries, []);
    assert.equal(f.ended, true);
  }
});

test('plaintext fixture exception is restricted to an isolated database and an actual loopback client', async () => {
  const database = 'colearnx_release_check_transport';
  const localConfig = { database, host: '127.0.0.1', testOnlyLocalTransport: true };
  const localIdentity = { ...identity, database, tls: false };
  const make = (host = '127.0.0.1') => fixture({ identity: localIdentity,
    client: { connection: { stream: {} }, connectionParameters: { host } } });
  const f = make();
  assert.deepEqual((await f.run({ config: localConfig })).transport, { mode: 'local-fixture', backendPgStatSsl: false });
  assert.equal(f.ended, true);
  assert.equal((await make('::1').run({ config: { ...localConfig, host: '[::1]' } })).transport.mode, 'local-fixture');
  assert.equal((await make('[::1]').run({ config: { ...localConfig, host: '::1' } })).transport.mode, 'local-fixture');
  for (const [settings, clientHost] of [
    [{ ...localConfig, database: 'colearnx' }, '127.0.0.1'],
    [{ ...localConfig, host: config.host }, config.host],
    [{ ...localConfig, host: undefined }, '127.0.0.1'],
    [{ ...localConfig, testOnlyLocalTransport: false }, '127.0.0.1'],
    [localConfig, config.host],
  ]) {
    const unsafe = make(clientHost);
    await assert.rejects(unsafe.run({ config: settings }), /must use verified TLS/);
    assert.deepEqual(unsafe.queries, []);
    assert.equal(unsafe.ended, true);
  }
});

for (const [key, value] of [['database', 'other'], ['role', 'neondb_owner'], ['session_role', 'owner'], ['read_only', 'off'],
  ['default_read_only', 'off'], ...['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolinherit', 'rolreplication', 'rolbypassrls', 'memberships',
    'database_create', 'schema_create', 'table_write', 'sequence_write'].map(key => [key, true])]) {
  test(`cloud preflight rejects unsafe identity/privileges before ledger read: ${key}`, async () => {
    const f = fixture({ identity: { ...identity, [key]: value } });
    await assert.rejects(f.run());
    assert.equal(f.queries.some(sql => sql.startsWith('SELECT filename')), false);
    assert.equal(f.ended, true);
    assert.equal(f.queries.at(-1), 'ROLLBACK');
  });
}

test('driver and permission failures are sanitized and close the client without a migration fallback', async () => {
  for (const client of [{ connect: async () => { throw new Error(env.STAGING_DATABASE_READONLY_URL); } },
    { query: async () => { throw new Error('sensitive SQL permission response'); } }]) {
    const f = fixture({ client });
    await assert.rejects(f.run(), error => /could not be completed/.test(error.message)
      && !error.message.includes('synthetic-password') && !error.message.includes('sensitive SQL'));
    assert.equal(f.ended, true);
  }
  const f = fixture({ ledger: ledger.slice(1) });
  await assert.rejects(f.run(), /migration count/);
  assert.equal(f.queries.at(-1), 'ROLLBACK');
});
