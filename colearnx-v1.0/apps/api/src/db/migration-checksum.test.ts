import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { matchesMigrationChecksum, migrationChecksum } from './migration-checksum.js';

const rawChecksum = (sql: string) => createHash('sha256').update(sql).digest('hex');

test('migration checksums are independent of line endings', () => {
  const lfSql = 'CREATE TABLE sample (id integer);\nINSERT INTO sample VALUES (1);\n';
  const crlfSql = lfSql.replace(/\n/g, '\r\n');

  assert.equal(migrationChecksum(lfSql), migrationChecksum(crlfSql));
  assert.equal(matchesMigrationChecksum(rawChecksum(lfSql), crlfSql), true);
  assert.equal(matchesMigrationChecksum(rawChecksum(crlfSql), lfSql), true);
});

test('migration checksums still reject a SQL change', () => {
  const originalSql = 'CREATE TABLE sample (id integer);\n';
  const changedSql = 'CREATE TABLE sample (id bigint);\n';

  assert.equal(matchesMigrationChecksum(rawChecksum(originalSql), changedSql), false);
});

test('migration checker recognises the verified original v1.0 checksum for migration 003', async () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const sql = await readFile(join(directory, '../../../../db/migrations/003_enterprise_access_and_query_hardening.sql'), 'utf8');

  assert.equal(matchesMigrationChecksum('c459c181ace342d0ec9de71f62744a9748f5ea986a2a0950ed677a6999ee9f09', sql), true);
});
