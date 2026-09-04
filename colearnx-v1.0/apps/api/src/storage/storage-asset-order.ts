export const REPLACEMENT_ASSET_ORDER = [
  { column: 'verified_at', sql: 'verified_at DESC NULLS LAST' },
  { column: 'created_at', sql: 'created_at ASC' },
  { column: 'storage_asset_id', sql: 'storage_asset_id ASC' },
] as const;

export const REPLACEMENT_ASSET_ORDER_BY_SQL = REPLACEMENT_ASSET_ORDER
  .map(({ sql }) => sql)
  .join(', ');
