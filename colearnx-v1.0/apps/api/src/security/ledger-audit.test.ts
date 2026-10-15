import assert from 'node:assert/strict';
import test from 'node:test';
import { auditLedgerBalances, diffAccountBalances, type LedgerBalanceRow } from './ledger-audit.js';

const balanced: LedgerBalanceRow = {
  point_account_id: 'acc-1', user_id: 'user-1', account_status: 'active',
  available_balance: '100', frozen_balance: '20', expired_balance: '0', blocked_balance: '0',
  available_sum: '100', frozen_sum: '20', expired_sum: '0', blocked_sum: '0',
};

test('a balanced account reports no discrepancies', () => {
  assert.deepEqual(diffAccountBalances(balanced), []);
});

test('each drifted balance field is reported with projected, ledger and signed delta', () => {
  const drifted: LedgerBalanceRow = { ...balanced, available_balance: '90', frozen_balance: '25' };
  assert.deepEqual(diffAccountBalances(drifted), [
    { field: 'available', projected: 90, ledger: 100, delta: -10 },
    { field: 'frozen', projected: 25, ledger: 20, delta: 5 },
  ]);
});

test('a balance beyond the safe integer range is surfaced, not silently rounded', () => {
  assert.throws(() => diffAccountBalances({ ...balanced, available_balance: '9007199254740993' }), /safe integer/);
});

function fakePool(rows: LedgerBalanceRow[], failQuery?: boolean) {
  const calls: string[] = [];
  let released = false;
  const pool = {
    async connect() {
      calls.push('connect');
      return {
        async query(sql: string) {
          if (sql.startsWith('BEGIN')) { calls.push('begin'); assert.match(sql, /READ ONLY/); return { rows: [], rowCount: null }; }
          if (sql === 'COMMIT') { calls.push('commit'); return { rows: [], rowCount: null }; }
          if (sql === 'ROLLBACK') { calls.push('rollback'); return { rows: [], rowCount: null }; }
          calls.push('select');
          if (failQuery) throw new Error('injected select failure');
          return { rows, rowCount: rows.length };
        },
        release() { released = true; calls.push('release'); },
      };
    },
  };
  return { pool, calls, get released() { return released; } };
}

test('the audit reads in a read-only snapshot and emits once per imbalanced account', async () => {
  const drifted: LedgerBalanceRow = { ...balanced, point_account_id: 'acc-2', available_balance: '90' };
  const fixture = fakePool([balanced, drifted]);
  const emitted: string[] = [];
  const summary = await auditLedgerBalances(fixture.pool, async (imbalance) => { emitted.push(imbalance.pointAccountId); });
  assert.deepEqual(summary, { accountsChecked: 2, imbalancedAccounts: 1 });
  assert.deepEqual(emitted, ['acc-2']);
  assert.deepEqual(fixture.calls, ['connect', 'begin', 'select', 'commit', 'release']);
  assert.equal(fixture.released, true);
});

test('a query failure rolls back the snapshot and releases the connection', async () => {
  const fixture = fakePool([], true);
  await assert.rejects(auditLedgerBalances(fixture.pool, async () => {}), /injected select failure/);
  assert.ok(fixture.calls.includes('rollback'));
  assert.ok(!fixture.calls.includes('commit'));
  assert.equal(fixture.released, true);
});
