import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyReleaseSource } from './source-guard.mjs';

const sha = 'a'.repeat(40);
const inventory = [{ filename: '001_fixture.sql', checksum: 'b'.repeat(64) }];
const env = { RELEASE_SHA: sha, GITHUB_REPOSITORY: 'ShubertChan/ColearnX-Training-Platform', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', MIGRATIONS_REVIEWED: 'true', LAST_APPLIED_MIGRATION: inventory[0].filename };
const options = { env, head: sha, inventory, fetchImpl: async () => Response.json({ object: { sha } }) };

test('manual release pins HEAD, main and exact required migration', async () => {
  assert.deepEqual(await verifyReleaseSource(options), { commit: sha, lastRequiredMigration: inventory[0].filename, migrationCount: 1 });
});

test('unreviewed migrations, wrong repository/event/ref and stale HEAD fail before network', async () => {
  for (const changed of [{ MIGRATIONS_REVIEWED: 'false' }, { LAST_APPLIED_MIGRATION: '000_old.sql' }, { GITHUB_REPOSITORY: 'attacker/fork' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'push' }]) {
    await assert.rejects(verifyReleaseSource({ ...options, env: { ...env, ...changed }, fetchImpl: () => assert.fail('No network allowed') }));
  }
  await assert.rejects(verifyReleaseSource({ ...options, head: 'c'.repeat(40), fetchImpl: () => assert.fail('No network allowed') }));
  for (const inventory of [undefined, [], {}]) {
    await assert.rejects(verifyReleaseSource({ ...options, inventory, fetchImpl: () => assert.fail('No network allowed') }), /Review cloud migrations/);
  }
});

test('a main update or unverifiable GitHub response prevents deployment without leaking details', async () => {
  await assert.rejects(verifyReleaseSource({ ...options, fetchImpl: async () => Response.json({ object: { sha: 'd'.repeat(40) } }) }), /no longer main/);
  for (const fetchImpl of [async () => { throw new Error('private-token-value'); }, async () => new Response('private-token-value', { status: 401 }), async () => new Response('invalid json')]) {
    await assert.rejects(verifyReleaseSource({ ...options, fetchImpl }), error => error.message === 'Cannot verify current GitHub main. No deployment is permitted.');
  }
});
