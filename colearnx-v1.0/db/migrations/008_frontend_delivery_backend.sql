-- Frontend integration requires private course fulfilment, protected course
-- files, server-recorded video progress, identity recovery, privacy requests,
-- and a durable draft cart.  This migration is additive and forward-only.

ALTER TABLE contents
  ADD COLUMN description text NOT NULL DEFAULT ''
    CHECK (length(description) <= 5000);

ALTER TABLE course_runs
  ADD COLUMN progress_tracking_type text NOT NULL DEFAULT 'none'
    CHECK (progress_tracking_type IN ('none', 'online_video')),
  ADD COLUMN total_duration_seconds integer
    CHECK (total_duration_seconds IS NULL OR total_duration_seconds > 0),
  ADD CONSTRAINT course_runs_progress_tracking_consistency_ck
    CHECK (
      (progress_tracking_type = 'none' AND total_duration_seconds IS NULL)
      OR (progress_tracking_type = 'online_video' AND total_duration_seconds IS NOT NULL)
    );

ALTER TABLE course_delivery_options
  ADD COLUMN fulfilment_instructions text
    CHECK (fulfilment_instructions IS NULL OR length(trim(fulfilment_instructions)) BETWEEN 1 AND 5000),
  ADD COLUMN trainer_contact text
    CHECK (trainer_contact IS NULL OR length(trim(trainer_contact)) BETWEEN 1 AND 500),
  ADD COLUMN join_url text
    CHECK (join_url IS NULL OR join_url ~* '^https?://[^[:space:]]+$');

CREATE TABLE course_delivery_assets (
  course_delivery_asset_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_run_id uuid NOT NULL REFERENCES course_runs(course_run_id) ON DELETE RESTRICT,
  owner_user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  asset_purpose text NOT NULL CHECK (asset_purpose IN ('cloud_download', 'online_video')),
  storage_provider text NOT NULL DEFAULT 'r2' CHECK (storage_provider = 'r2'),
  bucket_name text NOT NULL CHECK (length(trim(bucket_name)) BETWEEN 1 AND 255),
  object_key text NOT NULL
    CHECK (octet_length(object_key) BETWEEN 1 AND 1024)
    CHECK (object_key !~* '^https?://')
    CHECK (object_key !~* 'x-amz-signature'),
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 512),
  declared_content_type text NOT NULL CHECK (length(trim(declared_content_type)) BETWEEN 1 AND 255),
  verified_content_type text CHECK (verified_content_type IS NULL OR length(trim(verified_content_type)) BETWEEN 1 AND 255),
  declared_byte_size bigint NOT NULL CHECK (declared_byte_size > 0),
  verified_byte_size bigint CHECK (verified_byte_size IS NULL OR verified_byte_size > 0),
  etag text CHECK (etag IS NULL OR length(etag) BETWEEN 1 AND 255),
  checksum_sha256 char(64) CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'),
  asset_status text NOT NULL DEFAULT 'pending'
    CHECK (asset_status IN ('pending', 'uploaded', 'ready', 'quarantined', 'orphaned', 'delete_pending', 'deleted')),
  upload_expires_at timestamptz NOT NULL,
  uploaded_at timestamptz,
  verified_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket_name, object_key),
  CHECK (upload_expires_at > created_at),
  CHECK (asset_status <> 'ready' OR (
    verified_content_type IS NOT NULL
    AND verified_byte_size = declared_byte_size
    AND verified_at IS NOT NULL
  )),
  CHECK (asset_status <> 'deleted' OR deleted_at IS NOT NULL)
);

CREATE INDEX course_delivery_assets_run_status_idx
  ON course_delivery_assets (course_run_id, asset_purpose, created_at ASC)
  WHERE asset_status = 'ready';
CREATE INDEX course_delivery_assets_owner_cleanup_idx
  ON course_delivery_assets (owner_user_id, upload_expires_at ASC)
  WHERE asset_status IN ('pending', 'uploaded', 'delete_pending');
CREATE FUNCTION course_delivery_asset_owner_matches_course() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM course_runs cr JOIN courses c ON c.course_id = cr.course_id
    WHERE cr.course_run_id = NEW.course_run_id AND c.owner_user_id = NEW.owner_user_id
  ) THEN
    RAISE EXCEPTION 'course delivery asset owner must match the course owner';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION course_delivery_asset_owner_matches_course() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION course_delivery_asset_owner_matches_course() TO colearnx_app;
CREATE TRIGGER course_delivery_assets_owner_check
  BEFORE INSERT OR UPDATE OF course_run_id, owner_user_id ON course_delivery_assets
  FOR EACH ROW EXECUTE FUNCTION course_delivery_asset_owner_matches_course();


ALTER TABLE order_items
  ADD COLUMN delivery_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE course_video_progress_sessions (
  course_video_progress_session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id uuid NOT NULL REFERENCES order_items(order_item_id) ON DELETE RESTRICT,
  session_id uuid NOT NULL,
  reported_watched_seconds numeric(12,3) NOT NULL DEFAULT 0 CHECK (reported_watched_seconds >= 0),
  accepted_watched_seconds numeric(12,3) NOT NULL DEFAULT 0 CHECK (accepted_watched_seconds >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_item_id, session_id),
  CHECK (accepted_watched_seconds <= reported_watched_seconds)
);

CREATE INDEX course_video_progress_sessions_order_idx
  ON course_video_progress_sessions (order_item_id, updated_at DESC);

CREATE TABLE password_reset_challenges (
  password_reset_challenge_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_ip_hash char(64),
  CHECK (expires_at > requested_at)
);

CREATE UNIQUE INDEX password_reset_challenges_pending_user_uq
  ON password_reset_challenges (user_id) WHERE consumed_at IS NULL;
CREATE INDEX password_reset_challenges_token_lookup_idx
  ON password_reset_challenges (token_hash) WHERE consumed_at IS NULL;

CREATE TABLE privacy_requests (
  privacy_request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  request_type text NOT NULL CHECK (request_type IN ('data_export', 'account_deletion')),
  request_status text NOT NULL DEFAULT 'pending'
    CHECK (request_status IN ('pending', 'in_progress', 'completed', 'rejected', 'cancelled')),
  reason text,
  identity_verified_at timestamptz NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by_user_id uuid REFERENCES users(user_id) ON DELETE RESTRICT,
  decision_note text
);

CREATE UNIQUE INDEX privacy_requests_pending_type_uq
  ON privacy_requests (user_id, request_type) WHERE request_status IN ('pending', 'in_progress');
CREATE INDEX privacy_requests_review_queue_idx
  ON privacy_requests (request_status, requested_at ASC, privacy_request_id ASC);


ALTER TABLE cart_items
  ADD COLUMN seller_user_id uuid REFERENCES users(user_id) ON DELETE RESTRICT,
  ADD COLUMN last_seen_price_points bigint CHECK (last_seen_price_points >= 0),
  ADD COLUMN policy_preview_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN added_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX cart_items_cart_added_idx
  ON cart_items (cart_id, added_at ASC, cart_item_id ASC);

-- 003 revoked default privileges, so the runtime account needs explicit
-- column-level access to every new mutable operational table.
GRANT SELECT, INSERT ON course_delivery_assets TO colearnx_app;
GRANT UPDATE (
  verified_content_type, verified_byte_size, etag, checksum_sha256, asset_status,
  uploaded_at, verified_at, deleted_at, updated_at
) ON course_delivery_assets TO colearnx_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON course_video_progress_sessions TO colearnx_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset_challenges TO colearnx_app;
GRANT SELECT, INSERT, UPDATE ON privacy_requests TO colearnx_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON carts, cart_items TO colearnx_app;

