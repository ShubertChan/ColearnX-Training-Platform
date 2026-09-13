import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRetentionDays, runSecurityRetention } from './retention-sweep.js';

test('retention defaults to 180 days and accepts only complete bounded integers', () => {
  assert.equal(parseRetentionDays(undefined), 180);
  for (const value of ['30', '180', '730']) assert.equal(parseRetentionDays(value), Number(value));
  for (const value of ['', '30junk', '30.5', '180.0', '3e2', '0xB4', ' 180 ', '+180', '-30', '29', '731', 'Infinity']) {
    assert.throws(() => parseRetentionDays(value), /integer between 30 and 730/, value);
  }
});

function transactionFixture(failingDelete?: 'events' | 'tokens') {
  const calls: string[] = [];
  const committed = { events: 5, tokens: 7 };
  let pending = { ...committed };
  let active = false;
  let released = false;
  const pool = {
    async connect() {
      calls.push('connect');
      return {
        async query(sql: string, parameters?: number[]) {
          if (sql === 'BEGIN') {
            assert.equal(active, false);
            active = true;
            calls.push('begin');
          } else if (sql === 'COMMIT') {
            assert.equal(active, true);
            Object.assign(committed, pending);
            active = false;
            calls.push('commit');
          } else if (sql === 'ROLLBACK') {
            pending = { ...committed };
            active = false;
            calls.push('rollback');
          } else {
            assert.equal(active, true, 'deletions must run inside the same transaction');
            const operation = sql.includes('DELETE FROM security_events') ? 'events' : 'tokens';
            calls.push(operation);
            if (operation === 'events') {
              assert.deepEqual(parameters, [180]);
            } else {
              // Regression: the old CLI queried a table and columns that do
              // not exist in migration 008.
              assert.match(sql, /DELETE FROM password_reset_challenges/);
              assert.match(sql, /consumed_at IS NOT NULL OR expires_at < now\(\)/);
              assert.match(sql, /requested_at < now\(\) - interval '30 days'/);
              assert.doesNotMatch(sql, /invalidated_at|created_at|password_reset_tokens/);
            }
            if (operation === failingDelete) throw new Error(`injected ${operation} deletion failure`);
            const removed = pending[operation];
            pending[operation] = 0;
            return { rowCount: removed };
          }
          return { rowCount: null };
        },
        release() {
          assert.equal(active, false);
          released = true;
          calls.push('release');
        },
      };
    },
  };
  return { pool, committed, calls, get released() { return released; } };
}

test('retention commits both deletions together and releases its owner connection', async () => {
  const fixture = transactionFixture();
  assert.deepEqual(await runSecurityRetention(fixture.pool), { eventsRemoved: 5, tokensRemoved: 7 });
  assert.deepEqual(fixture.committed, { events: 0, tokens: 0 });
  assert.deepEqual(fixture.calls, ['connect', 'begin', 'events', 'tokens', 'commit', 'release']);
  assert.equal(fixture.released, true);
});

test('a failure in either cleanup preserves both tables and releases the connection', async () => {
  for (const operation of ['events', 'tokens'] as const) {
    const fixture = transactionFixture(operation);
    await assert.rejects(runSecurityRetention(fixture.pool), new RegExp(`injected ${operation} deletion failure`));
    assert.deepEqual(fixture.committed, { events: 5, tokens: 7 });
    assert.ok(fixture.calls.includes('rollback'));
    assert.ok(!fixture.calls.includes('commit'));
    assert.equal(fixture.released, true);
  }
});

test('invalid programmatic retention periods fail before connecting', async () => {
  const fixture = transactionFixture();
  for (const days of [29, 731, 30.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(runSecurityRetention(fixture.pool, days), /integer between 30 and 730/);
  }
  assert.deepEqual(fixture.calls, []);
});
