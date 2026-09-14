import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The database is the contract. A handler that queries a table or column the
// migrations never created compiles and type-checks cleanly, then fails at
// runtime against the deployed database with a 500. Two whole modules had
// drifted that way before this test existed, so the SQL in src is checked
// against db/migrations here rather than only in production.

const apiRoot = fileURLToPath(new URL('../..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const migrationsDir = join(repoRoot, 'db', 'migrations');

function schemaColumns() {
  const columns = new Map<string, Set<string>>();
  const add = (table: string, column: string) => {
    const known = columns.get(table) ?? new Set<string>();
    known.add(column.toLowerCase());
    columns.set(table, known);
  };
  // The migration runner owns this table; it is not declared by a migration.
  add('schema_migrations', 'filename');
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    for (const table of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\);/gi)) {
      let depth = 0;
      for (const line of table[2].split('\n')) {
        const declaration = depth === 0 ? line.trim().match(/^([a-z_][a-z0-9_]*)\s+[a-z]/i) : null;
        if (declaration && !/^(constraint|check|unique|primary|foreign|exclude|like)$/i.test(declaration[1])) {
          add(table[1].toLowerCase(), declaration[1]);
        }
        depth += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
      }
    }
    for (const altered of sql.matchAll(/ALTER TABLE (?:IF EXISTS )?([a-z_][a-z0-9_]*)([\s\S]*?);/gi)) {
      for (const added of altered[2].matchAll(/ADD COLUMN (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi)) {
        add(altered[1].toLowerCase(), added[1]);
      }
    }
  }
  return columns;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

// Words that follow FROM/JOIN in valid SQL without naming a stored table.
const notATable = new Set(['lateral', 'unnest', 'generate_series', 'jsonb_array_elements', 'jsonb_array_elements_text', 'json_array_elements', 'pg_indexes', 'pg_tables', 'pg_class', 'information_schema']);
const notAnAlias = new Set(['on', 'where', 'set', 'values', 'using', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'natural', 'group', 'order', 'limit', 'offset', 'returning', 'as', 'and', 'or', 'join', 'select', 'union', 'for']);

function statements(source: string) {
  return [...source.matchAll(/`([^`]*)`/g)]
    .map((literal) => ({ sql: literal[1], line: source.slice(0, literal.index).split('\n').length }))
    .filter(({ sql }) => /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(sql));
}

test('every table and column the API queries exists in db/migrations', () => {
  const columns = schemaColumns();
  assert.ok(columns.size > 40, 'the migration parser found too few tables to be trusted');
  const problems: string[] = [];

  for (const path of sourceFiles(join(apiRoot, 'src'))) {
    const where = relative(repoRoot, path).replaceAll(sep, '/');
    const source = readFileSync(path, 'utf8');
    for (const { sql, line } of statements(source)) {
      // Common table expressions are defined by the statement itself.
      const local = new Set([...sql.matchAll(/([a-z_][a-z0-9_]*)\s+AS\s*\(/gi)].map((cte) => cte[1].toLowerCase()));
      const tableOf = new Map<string, string>();
      // "FOR UPDATE OF x" and "ON CONFLICT DO UPDATE SET" both put a keyword
      // where a table name would otherwise sit.
      const scannable = sql
        .replace(/\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b/gi, ' ')
        .replace(/\bFOR\s+(?:KEY\s+)?SHARE\b/gi, ' ')
        .replace(/\bDO\s+UPDATE\b/gi, ' ');

      for (const source_ of scannable.matchAll(/\b(?:FROM|JOIN|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi)) {
        const table = source_[1].toLowerCase();
        if (local.has(table) || notATable.has(table)) continue;
        if (!columns.has(table)) {
          problems.push(`${where}:${line} queries table "${table}", which no migration creates`);
          continue;
        }
        tableOf.set(table, table);
        const alias = (source_[2] ?? '').toLowerCase();
        if (alias && !notAnAlias.has(alias)) tableOf.set(alias, table);
      }

      for (const reference of sql.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/g)) {
        const table = tableOf.get(reference[1].toLowerCase());
        if (table && !columns.get(table)!.has(reference[2].toLowerCase())) {
          problems.push(`${where}:${line} reads ${table}.${reference[2]}, which no migration creates`);
        }
      }

      for (const inserted of sql.matchAll(/INSERT\s+INTO\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi)) {
        const table = inserted[1].toLowerCase();
        if (!columns.has(table)) continue;
        for (const column of inserted[2].split(',').map((name) => name.trim().toLowerCase())) {
          if (/^[a-z_][a-z0-9_]*$/.test(column) && !columns.get(table)!.has(column)) {
            problems.push(`${where}:${line} inserts ${table}.${column}, which no migration creates`);
          }
        }
      }

      for (const updated of scannable.matchAll(/UPDATE\s+([a-z_][a-z0-9_]*)\s+SET\s+([\s\S]*?)(?:\s+WHERE\s|\s+RETURNING\s|$)/gi)) {
        const table = updated[1].toLowerCase();
        if (!columns.has(table)) continue;
        for (const assignment of updated[2].split(',')) {
          const column = (assignment.split('=')[0] ?? '').trim().toLowerCase();
          if (/^[a-z_][a-z0-9_]*$/.test(column) && !columns.get(table)!.has(column)) {
            problems.push(`${where}:${line} writes ${table}.${column}, which no migration creates`);
          }
        }
      }
    }
  }

  assert.deepEqual([...new Set(problems)], [], `SQL in the API no longer matches db/migrations:\n${[...new Set(problems)].join('\n')}`);
});
