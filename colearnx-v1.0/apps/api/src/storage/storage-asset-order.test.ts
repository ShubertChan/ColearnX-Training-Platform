import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { REPLACEMENT_ASSET_ORDER, REPLACEMENT_ASSET_ORDER_BY_SQL } from './storage-asset-order.js';

test('replacement attachment ordering only references storage_assets columns', async () => {
  const migration = await readFile(
    new URL('../../../../db/migrations/005_object_storage.sql', import.meta.url),
    'utf8',
  );

  for (const { column } of REPLACEMENT_ASSET_ORDER) {
    assert.match(migration, new RegExp(`^\\s*${column}\\s`, 'm'));
  }
  assert.equal(
    REPLACEMENT_ASSET_ORDER_BY_SQL,
    'verified_at DESC NULLS LAST, created_at ASC, storage_asset_id ASC',
  );
  assert.doesNotMatch(REPLACEMENT_ASSET_ORDER_BY_SQL, /\bcompleted_at\b/);
});
