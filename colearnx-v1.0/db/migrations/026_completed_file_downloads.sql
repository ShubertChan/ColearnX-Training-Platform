-- Historical link claims cannot establish that a file was delivered.
CREATE TABLE file_download_tracking (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  started_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO file_download_tracking DEFAULT VALUES;
REVOKE ALL ON file_download_tracking FROM PUBLIC, colearnx_app;
GRANT SELECT ON file_download_tracking TO colearnx_app;

ALTER TABLE order_items ADD COLUMN completed_file_downloads bigint NOT NULL DEFAULT 0
  CHECK (completed_file_downloads >= 0);
CREATE INDEX order_items_downloaded_run_idx ON order_items(course_run_id)
  WHERE course_run_id IS NOT NULL AND completed_file_downloads > 0;
CREATE INDEX order_items_downloaded_version_idx ON order_items(content_version_id)
  WHERE content_version_id IS NOT NULL AND completed_file_downloads > 0;

-- Only the hash of a short-lived bearer link is stored.
CREATE TABLE file_download_links (
  token_hash text PRIMARY KEY,
  order_item_id uuid NOT NULL REFERENCES order_items ON DELETE CASCADE,
  content_asset_id uuid REFERENCES storage_assets ON DELETE CASCADE,
  course_asset_id uuid REFERENCES course_delivery_assets ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  CHECK (num_nonnulls(content_asset_id, course_asset_id) = 1)
);
CREATE INDEX file_download_links_expiry_idx ON file_download_links(expires_at);
CREATE TABLE file_download_transfers (
  transfer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL REFERENCES file_download_links ON DELETE CASCADE,
  full_started boolean NOT NULL DEFAULT false,
  source_etag text,
  delivered int8multirange NOT NULL DEFAULT '{}',
  completed boolean NOT NULL DEFAULT false
);
CREATE INDEX file_download_transfers_link_idx ON file_download_transfers(token_hash);
REVOKE ALL ON file_download_links, file_download_transfers FROM PUBLIC, colearnx_app, colearnx_readonly;
GRANT SELECT, INSERT, DELETE ON file_download_links TO colearnx_app;
-- The bounded expiry cleanup locks selected rows before deleting them.
GRANT UPDATE (expires_at) ON file_download_links TO colearnx_app;
GRANT SELECT, INSERT, UPDATE (full_started, source_etag, delivered, completed) ON file_download_transfers TO colearnx_app;
GRANT UPDATE (completed_file_downloads) ON order_items TO colearnx_app;
