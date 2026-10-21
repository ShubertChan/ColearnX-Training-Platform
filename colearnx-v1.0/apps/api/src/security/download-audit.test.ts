import assert from 'node:assert/strict';
import test from 'node:test';
import type { DownloadAuditPool } from './download-audit.js';

// download-audit.ts imports the request-path recorder, which loads the shared
// environment module. Inert values only; nothing connects anywhere.
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret-that-is-long-enough';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret-that-is-long-enough';
process.env.CSRF_SECRET = 'test-csrf-secret-that-is-long-enough';
const {
  assessDownloadPattern, DISTINCT_NETWORK_THRESHOLD, DOWNLOAD_PATTERN_SQL, ISSUE_VOLUME_THRESHOLD, runDownloadAudit,
} = await import('./download-audit.js');

const base = { actorUserId: 'u1', assetId: 'a1', assetKind: 'content' };

test('one person on a few devices is not flagged', () => {
  assert.equal(assessDownloadPattern({ ...base, issued: 6, networks: DISTINCT_NETWORK_THRESHOLD - 1 }), null);
});

test('many networks for one file, and scripted re-issuing, are flagged and scored', () => {
  const networks = assessDownloadPattern({ ...base, issued: 5, networks: DISTINCT_NETWORK_THRESHOLD });
  assert.deepEqual(networks?.ruleHits, ['download_many_networks']);
  assert.equal(networks?.riskScore, 50);
  const both = assessDownloadPattern({ ...base, issued: ISSUE_VOLUME_THRESHOLD, networks: 9 });
  assert.deepEqual(both?.ruleHits, ['download_many_networks', 'download_volume']);
  assert.equal(both?.riskScore, 80);
  // Never pages: the batch job must not depend on the alert channel.
  assert.equal(both?.severity, 2);
});

function fakePool(rows: unknown[]) {
  const seen: Array<{ sql: string; parameters?: unknown[] }> = [];
  let released = 0;
  const pool: DownloadAuditPool = {
    async connect() {
      return {
        async query(sql: string, parameters?: unknown[]) { seen.push({ sql, parameters }); return { rows, rowCount: rows.length }; },
        release() { released += 1; },
      };
    },
  };
  return { pool, seen, released: () => released };
}

test('the audit reads the issuance ledger, emits one event per finding and counts lost writes', async () => {
  const { pool, seen, released } = fakePool([
    { actor: 'u1', asset_id: 'a1', asset_kind: 'content', issued: '7', networks: '5' },
    { actor: 'u2', asset_id: 'a2', asset_kind: 'course', issued: '40', networks: '1' },
    { actor: 'u3', asset_id: null, asset_kind: null, issued: '99', networks: '9' },
  ]);
  const emitted: string[] = [];
  const summary = await runDownloadAudit(pool, async (verdict) => {
    if (verdict.actorUserId === 'u2') throw new Error('insert failed');
    emitted.push(verdict.actorUserId);
  }, { windowHours: 12 });
  assert.deepEqual(summary, { patternsAssessed: 3, flagged: 2, recordFailures: 1 });
  assert.deepEqual(emitted, ['u1']);
  assert.equal(seen[0].sql, DOWNLOAD_PATTERN_SQL);
  assert.deepEqual(seen[0].parameters, [12, DISTINCT_NETWORK_THRESHOLD, ISSUE_VOLUME_THRESHOLD]);
  assert.equal(released(), 1);
});
