-- Support the per-creator storage quota check on every upload intent.
CREATE INDEX storage_assets_owner_status_quota_idx
  ON storage_assets (owner_user_id, asset_status, upload_expires_at)
  WHERE asset_status <> 'deleted';
