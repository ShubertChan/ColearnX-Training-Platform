-- Forward-only, additive object-storage metadata support.
-- Existing content_versions.storage_url remains available for legacy rows.

CREATE TABLE storage_assets (
  storage_asset_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_version_id uuid NOT NULL
    REFERENCES content_versions(content_version_id) ON DELETE RESTRICT,
  owner_user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  storage_provider text NOT NULL DEFAULT 'r2'
    CHECK (storage_provider = 'r2'),
  asset_purpose text NOT NULL DEFAULT 'content_primary'
    CHECK (asset_purpose = 'content_primary'),
  bucket_name text NOT NULL
    CHECK (length(trim(bucket_name)) BETWEEN 1 AND 255),
  object_key text NOT NULL
    CHECK (octet_length(object_key) BETWEEN 1 AND 1024)
    CHECK (object_key !~* '^https?://')
    CHECK (object_key !~* 'x-amz-signature'),
  original_filename text NOT NULL
    CHECK (length(original_filename) BETWEEN 1 AND 512),
  declared_content_type text NOT NULL
    CHECK (length(trim(declared_content_type)) BETWEEN 1 AND 255),
  verified_content_type text
    CHECK (verified_content_type IS NULL OR length(trim(verified_content_type)) BETWEEN 1 AND 255),
  declared_byte_size bigint NOT NULL
    CHECK (declared_byte_size > 0),
  verified_byte_size bigint
    CHECK (verified_byte_size IS NULL OR verified_byte_size > 0),
  etag text
    CHECK (etag IS NULL OR length(etag) BETWEEN 1 AND 255),
  checksum_sha256 char(64)
    CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'),
  asset_status text NOT NULL DEFAULT 'pending'
    CHECK (asset_status IN (
      'pending',
      'uploaded',
      'ready',
      'quarantined',
      'orphaned',
      'delete_pending',
      'deleted'
    )),
  upload_expires_at timestamptz NOT NULL,
  uploaded_at timestamptz,
  verified_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket_name, object_key),
  UNIQUE (storage_asset_id, content_version_id),
  CHECK (upload_expires_at > created_at),
  CHECK (
    asset_status <> 'ready'
    OR (
      verified_content_type IS NOT NULL
      AND verified_byte_size = declared_byte_size
      AND verified_at IS NOT NULL
    )
  ),
  CHECK (asset_status <> 'deleted' OR deleted_at IS NOT NULL)
);

CREATE INDEX storage_assets_owner_created_idx
  ON storage_assets (owner_user_id, created_at DESC, storage_asset_id DESC);

CREATE INDEX storage_assets_content_status_idx
  ON storage_assets (content_version_id, asset_status, created_at DESC);

CREATE INDEX storage_assets_pending_cleanup_idx
  ON storage_assets (upload_expires_at, storage_asset_id)
  WHERE asset_status IN ('pending', 'uploaded');

CREATE INDEX storage_assets_orphan_cleanup_idx
  ON storage_assets (updated_at, storage_asset_id)
  WHERE asset_status IN ('orphaned', 'delete_pending');

ALTER TABLE content_versions
  ADD COLUMN storage_asset_id uuid;

ALTER TABLE content_versions
  ADD CONSTRAINT content_versions_storage_asset_fk
  FOREIGN KEY (storage_asset_id, content_version_id)
  REFERENCES storage_assets(storage_asset_id, content_version_id)
  ON DELETE RESTRICT;

-- A primary content-version file is not shared by several versions.
CREATE UNIQUE INDEX content_versions_storage_asset_uq
  ON content_versions (storage_asset_id)
  WHERE storage_asset_id IS NOT NULL;

-- 003 revoked default grants. New objects require explicit least-privilege grants.
REVOKE ALL PRIVILEGES ON TABLE storage_assets
  FROM PUBLIC, colearnx_app, colearnx_migrator, colearnx_readonly;

GRANT SELECT, INSERT ON TABLE storage_assets TO colearnx_app;

GRANT UPDATE (
  verified_content_type,
  verified_byte_size,
  etag,
  checksum_sha256,
  asset_status,
  uploaded_at,
  verified_at,
  deleted_at,
  updated_at
) ON TABLE storage_assets TO colearnx_app;
