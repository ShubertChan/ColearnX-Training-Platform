import { createHash } from 'node:crypto';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

const normalizeLineEndings = (sql: string) => sql.replace(/\r\n?/g, '\n');

/**
 * New migrations use a platform-independent checksum.  SQL text remains
 * protected, while a Windows checkout cannot look different from an LF one.
 */
export const migrationChecksum = (sql: string) => hash(normalizeLineEndings(sql));

/**
 * Older releases stored the raw file checksum.  Accept those historical LF
 * and CRLF forms only; any substantive SQL change still fails closed.
 */
export const matchesMigrationChecksum = (recordedChecksum: string, sql: string) => {
  const canonicalSql = normalizeLineEndings(sql);
  return [
    hash(canonicalSql),
    hash(sql),
    hash(canonicalSql.replace(/\n/g, '\r\n')),
  ].includes(recordedChecksum);
};
