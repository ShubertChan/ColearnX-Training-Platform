import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
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
