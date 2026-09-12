import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { cleanupAssetEligible, cleanupCandidateSql, reconcileStorage, type CleanupAsset, type CleanupKind } from './storage-reconciliation.js';

const now = new Date('2026-09-12T10:00:00Z');
function asset(overrides: Partial<CleanupAsset> = {}): CleanupAsset {
  return { asset_id: 'asset-1', bucket_name: 'test-private', object_key: 'test/key', asset_status: 'pending',
    upload_expires_at: new Date(now.getTime() - 61_000), parent_status: 'draft', version_status: 'draft',
    has_reference: false, has_direct_reference: false, ...overrides };
}

test('cleanup eligibility protects live URLs, published/ready files and historical purchase references', () => {
  for (const kind of ['content', 'course'] as const) {
    assert.equal(cleanupAssetEligible(kind, asset(), now), true);
    for (const status of ['uploaded', 'orphaned', 'delete_pending']) {
      assert.equal(cleanupAssetEligible(kind, asset({ asset_status: status }), now), true);
    }
    for (const status of ['ready', 'quarantined', 'deleted', 'unexpected']) {
      assert.equal(cleanupAssetEligible(kind, asset({ asset_status: status }), now), false);
    }
    for (const status of ['published', 'submitted', 'approved']) {
      assert.equal(cleanupAssetEligible(kind, asset({ parent_status: status }), now), false);
      assert.equal(cleanupAssetEligible(kind, asset({ version_status: status }), now), false);
    }
    assert.equal(cleanupAssetEligible(kind, asset({ has_reference: true }), now), false);
    assert.equal(cleanupAssetEligible(kind, asset({ upload_expires_at: new Date(now.getTime() - 59_999) }), now), false);
    assert.equal(cleanupAssetEligible(kind, asset({ upload_expires_at: new Date(now.getTime() - 60_000) }), now), true);
    assert.equal(cleanupAssetEligible(kind, asset({ upload_expires_at: 'invalid' }), now), false);
    assert.equal(cleanupAssetEligible(kind, asset({ upload_expires_at: new Date(now.getTime() + 10_000) }), now), false);
  }
});

test('actual content draft deletion lifecycle is archived parent plus retired version', () => {
  const deletedDraft = asset({ parent_status: 'archived', version_status: 'retired', asset_status: 'ready' });
  assert.equal(cleanupAssetEligible('content', deletedDraft, now), true);
  assert.equal(cleanupAssetEligible('content', { ...deletedDraft, has_reference: true }, now), false);
  assert.equal(cleanupAssetEligible('content', { ...deletedDraft, has_direct_reference: true }, now), false);
  assert.equal(cleanupAssetEligible('course', deletedDraft, now), false);
  assert.equal(cleanupAssetEligible('course', { ...deletedDraft, version_status: 'archived' }, now), true);
  assert.equal(cleanupAssetEligible('content', { ...deletedDraft, parent_status: 'draft' }, now), false);
});

test('remove then publish retains cleanup of tombstones without touching buyer-ready files', () => {
  for (const kind of ['content', 'course'] as const) {
    const published = asset({ parent_status: 'published', version_status: 'published', has_reference: true });
    assert.equal(cleanupAssetEligible(kind, { ...published, asset_status: 'delete_pending' }, now), true);
    for (const status of ['ready', 'pending', 'uploaded', 'quarantined', 'orphaned']) {
      assert.equal(cleanupAssetEligible(kind, { ...published, asset_status: status }, now), false);
    }
    assert.equal(cleanupAssetEligible(kind, { ...published, asset_status: 'delete_pending', has_direct_reference: true }, now), false);
    assert.equal(cleanupAssetEligible(kind, { ...published, asset_status: 'delete_pending', upload_expires_at: now }, now), false);
  }
});

test('candidate SQL contains kind-specific lifecycle, direct references, buyer references and expiry guards', () => {
  const content = cleanupCandidateSql('content');
  assert.match(content, /FROM storage_assets sa/);
  assert.match(content, /cv\.version_status IN \('draft', 'retired'\)/);
  assert.match(content, /primary_file\.storage_asset_id = sa\.storage_asset_id/);
  assert.match(content, /FROM content_access_grants/);
  const course = cleanupCandidateSql('course');
  assert.match(course, /FROM course_delivery_assets sa/);
  assert.match(course, /cr\.run_status IN \('draft', 'archived'\)/);
  assert.match(course, /FROM course_enrolments/);
  for (const sql of [content, course]) {
    assert.match(sql, /FROM order_items/);
    assert.match(sql, /upload_expires_at \+ \(60 \* interval '1 second'\) <= now\(\)/);
    assert.match(sql, /sa\.asset_status = 'delete_pending'/);
    assert.match(sql, /ANY\(\$1::uuid\[\]\)/);
    assert.match(sql, /LIMIT \$2/);
  }
});

function fixture(initial: Array<{ kind: CleanupKind; asset: CleanupAsset }>, options: {
  fails?: string[]; beforeLock?: (value: CleanupAsset) => CleanupAsset | undefined;
} = {}) {
  const rows = new Map(initial.map((entry) => [entry.asset.asset_id, { kind: entry.kind, asset: { ...entry.asset } }]));
  const calls: string[] = [];
  const updates: string[] = [];
  let transactionActive = false;
  let parentLocked = false;
  let locked = false;
  const dependencies = {
    now: () => now,
    withTransaction: async <T>(work: (client: PoolClient) => Promise<T>) => {
      assert.equal(transactionActive, false);
      transactionActive = true;
      parentLocked = false;
      locked = false;
      const client = { query: async (sql: string, params: unknown[]) => {
        const marker = /cleanup:(list|parent|lock|deferred|deleted):(content|course)/.exec(sql);
        assert.ok(marker, 'all cleanup SQL identifies its operation');
        const [, operation, kind] = marker;
        if (operation === 'list') {
          const [seen, limit] = params as [string[], number];
          // Deliberately return stale/ineligible records, testing the under-lock safety recheck.
          return { rows: [...rows.values()].filter((entry) => entry.kind === kind
            && !seen.includes(entry.asset.asset_id) && entry.asset.asset_status !== 'deleted')
            .slice(0, limit).map((entry) => ({ ...entry.asset })) };
        }
        const entry = rows.get(params[0] as string);
        assert.ok(entry);
        if (operation === 'parent') {
          assert.match(sql, /FOR UPDATE OF (cv|cr), c SKIP LOCKED/);
          assert.equal(locked, false, 'parent/version is locked before the asset');
          parentLocked = true;
          return { rows: [{ asset_id: entry.asset.asset_id }] };
        }
        if (operation === 'lock') {
          assert.equal(parentLocked, true, 'parent/version is locked before the asset');
          assert.match(sql, /FOR UPDATE OF sa SKIP LOCKED/);
          locked = true;
          const current = options.beforeLock ? options.beforeLock(entry.asset) : entry.asset;
          return { rows: current ? [{ ...current }] : [] };
        }
        assert.equal(locked, true, 'status changes are locked');
        entry.asset.asset_status = operation === 'deleted' ? 'deleted' : 'delete_pending';
        assert.match(sql, /updated_at = now\(\)/);
        updates.push(`${operation}:${entry.asset.asset_id}`);
        return { rows: [] };
      } } as unknown as PoolClient;
      try { return await work(client); } finally { transactionActive = false; parentLocked = false; locked = false; }
    },
    deleteObject: async (object: { bucketName: string; objectKey: string }) => {
      assert.equal(transactionActive, true, 'transaction remains open through R2 deletion');
      assert.equal(parentLocked, true, 'parent/version remains locked through R2 deletion');
      assert.equal(locked, true, 'asset and parent remain locked through R2 deletion');
      assert.equal(object.bucketName, 'test-private');
      calls.push(object.objectKey);
      if (options.fails?.includes(object.objectKey)) throw new Error('injected provider failure');
    },
  };
  return { dependencies, rows, calls, updates };
}

test('cleanup removes expired content/course uploads and archived draft files under locks', async () => {
  const state = fixture([
    { kind: 'content', asset: asset({ asset_id: 'c1', object_key: 'c1' }) },
    { kind: 'content', asset: asset({ asset_id: 'c2', object_key: 'c2', asset_status: 'quarantined', parent_status: 'archived', version_status: 'retired' }) },
    { kind: 'course', asset: asset({ asset_id: 't1', object_key: 't1' }) },
    { kind: 'course', asset: asset({ asset_id: 't2', object_key: 't2', asset_status: 'ready', parent_status: 'archived', version_status: 'archived' }) },
  ]);
  assert.deepEqual(await reconcileStorage(state.dependencies), { removed: 4, deferred: 0, skipped: 0 });
  assert.deepEqual(state.calls, ['c1', 'c2', 't1', 't2']);
  assert.ok([...state.rows.values()].every((entry) => entry.asset.asset_status === 'deleted'));
});

test('failed deletion is deferred once per run without starving newer files and can succeed next run', async () => {
  const failures = ['old'];
  const state = fixture([
    { kind: 'course', asset: asset({ asset_id: 'old', object_key: 'old', asset_status: 'delete_pending' }) },
    { kind: 'course', asset: asset({ asset_id: 'new', object_key: 'new' }) },
  ], { fails: failures });
  assert.deepEqual(await reconcileStorage(state.dependencies, { batchSize: 1 }), { removed: 1, deferred: 1, skipped: 0 });
  assert.deepEqual(state.calls, ['old', 'new']);
  assert.equal(state.rows.get('old')?.asset.asset_status, 'delete_pending');
  failures.length = 0;
  assert.deepEqual(await reconcileStorage(state.dependencies), { removed: 1, deferred: 0, skipped: 0 });
  assert.deepEqual(state.calls, ['old', 'new', 'old']);
});

test('stale candidates that gain publication or purchase references are skipped', async () => {
  for (const change of [{ parent_status: 'published' }, { has_reference: true }, { has_direct_reference: true }, { upload_expires_at: now }]) {
    const state = fixture([{ kind: 'content', asset: asset() }], { beforeLock: (value) => ({ ...value, ...change }) });
    assert.deepEqual(await reconcileStorage(state.dependencies), { removed: 0, deferred: 0, skipped: 1 });
    assert.deepEqual(state.calls, []);
  }
  const lockedElsewhere = fixture([{ kind: 'course', asset: asset() }], { beforeLock: () => undefined });
  assert.deepEqual(await reconcileStorage(lockedElsewhere.dependencies), { removed: 0, deferred: 0, skipped: 1 });
  assert.deepEqual(lockedElsewhere.calls, []);
});

test('post-publication tombstone is cleaned while ready attachment in same purchased version is preserved', async () => {
  for (const kind of ['content', 'course'] as const) {
    const live = { parent_status: 'published', version_status: 'published', has_reference: true };
    const state = fixture([
      { kind, asset: asset({ ...live, asset_id: 'removed', object_key: 'removed', asset_status: 'delete_pending' }) },
      { kind, asset: asset({ ...live, asset_id: 'ready', object_key: 'ready', asset_status: 'ready' }) },
      { kind, asset: asset({ ...live, asset_id: 'primary', object_key: 'primary', asset_status: 'delete_pending', has_direct_reference: true }) },
    ]);
    assert.deepEqual(await reconcileStorage(state.dependencies), { removed: 1, deferred: 0, skipped: 2 });
    assert.deepEqual(state.calls, ['removed']);
  }
});

test('cleanup is bounded and rejects unsafe batch settings', async () => {
  const state = fixture(Array.from({ length: 4 }, (_, index) => ({ kind: 'course' as const,
    asset: asset({ asset_id: `asset-${index}`, object_key: `key-${index}` }) })));
  assert.deepEqual(await reconcileStorage(state.dependencies, { batchSize: 1, maxBatches: 2 }), { removed: 2, deferred: 0, skipped: 0 });
  assert.equal(state.calls.length, 2);
  for (const options of [{ batchSize: 0 }, { batchSize: 101 }, { maxBatches: 0 }, { maxBatches: 11 }]) {
    await assert.rejects(reconcileStorage(state.dependencies, options), /Invalid cleanup batch limits/);
  }
});
