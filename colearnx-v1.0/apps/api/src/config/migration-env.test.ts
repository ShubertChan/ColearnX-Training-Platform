import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMigrationEnv } from './migration-env.js';

test('migration environment requires only the controlled migration URL and SSL mode', () => {
  const parsed = parseMigrationEnv({
    MIGRATION_DATABASE_URL: 'postgresql://migrator:password@example.test/colearnx?sslmode=require',
    DATABASE_SSL: 'true',
  });

  assert.equal(parsed.MIGRATION_DATABASE_URL, 'postgresql://migrator:password@example.test/colearnx?sslmode=require');
  assert.equal(parsed.DATABASE_SSL, true);
});

test('migration environment does not accept a missing migration URL', () => {
  assert.throws(() => parseMigrationEnv({ DATABASE_SSL: 'true' }), /MIGRATION_DATABASE_URL/);
});
