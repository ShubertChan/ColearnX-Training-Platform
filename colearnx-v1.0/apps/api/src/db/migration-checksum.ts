import { createHash } from 'node:crypto';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

const normalizeLineEndings = (sql: string) => sql.replace(/\r\n?/g, '\n');

// The original local v1.0 database recorded these three migration revisions
// before the source files were retained alongside the repository. The schema
// has since been verified and forward migrations 006–008 apply cleanly.
// Keep this narrow allow-list so a real historical database can be upgraded
// without accepting arbitrary checksum substitutions.
const historicalChecksumAliases = new Map<string, readonly string[]>([
  ['580797c25f7f9ec9ede2f11fede6c880e53ddde5bb947c9db78b32cd295e58c4', ['c459c181ace342d0ec9de71f62744a9748f5ea986a2a0950ed677a6999ee9f09']],
  ['0c5235dc82345b91c50932fe7fc695fb6914db2b00eb6596e111322616f14d4d', ['cb844cc6c5e315e85fe9a73febf8f76e6a149d37547288eb93df6244492bf03d']],
  ['e4fc8f510a218e8a5b97fcc765c7124ae5ac21926c9c1e6a77c181a1d159753f', ['f4525f8af56d697795cc5cf524687c74d813c8af40f8abce3f27c0be69ab29d7']],
]);

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
  const validChecksums = [
    hash(canonicalSql),
    hash(sql),
    hash(canonicalSql.replace(/\n/g, '\r\n')),
  ];
  return validChecksums.includes(recordedChecksum)
    || historicalChecksumAliases.get(validChecksums[0])?.includes(recordedChecksum) === true;
};
