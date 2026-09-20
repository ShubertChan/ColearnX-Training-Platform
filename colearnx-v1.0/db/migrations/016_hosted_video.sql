-- Hosted-video V1 is an expand-only migration. Existing attachment delivery
-- and historical online_video rows remain readable while new orders bind to an
-- immutable, processed video version.

ALTER TABLE course_delivery_assets
  DROP CONSTRAINT course_delivery_assets_asset_purpose_check,
  ADD CONSTRAINT course_delivery_assets_asset_purpose_check
    CHECK (asset_purpose IN ('cloud_download', 'online_video', 'video_source'));

ALTER TABLE course_runs
  DROP CONSTRAINT course_runs_progress_tracking_consistency_ck,
  ADD CONSTRAINT course_runs_progress_tracking_consistency_ck
    CHECK ((progress_tracking_type = 'none' AND total_duration_seconds IS NULL)
      OR progress_tracking_type = 'online_video');

CREATE TABLE course_video_versions (
  course_video_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_run_id uuid NOT NULL REFERENCES course_runs(course_run_id) ON DELETE RESTRICT,
  source_asset_id uuid NOT NULL REFERENCES course_delivery_assets(course_delivery_asset_id) ON DELETE RESTRICT,
  version_no integer NOT NULL CHECK (version_no > 0),
  video_status text NOT NULL DEFAULT 'upload_pending'
    CHECK (video_status IN ('upload_pending', 'queued', 'transcoding', 'ready', 'failed', 'superseded', 'delete_pending', 'deleted')),
  is_current boolean NOT NULL DEFAULT false,
  source_upload_id text,
  source_upload_part_size_bytes integer NOT NULL DEFAULT 8388608 CHECK (source_upload_part_size_bytes >= 5242880),
  duration_seconds numeric(12,3) CHECK (duration_seconds IS NULL OR duration_seconds > 0 AND duration_seconds <= 14400),
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  hls_bucket_name text CHECK (hls_bucket_name IS NULL OR length(trim(hls_bucket_name)) BETWEEN 1 AND 255),
  hls_output_prefix text CHECK (hls_output_prefix IS NULL OR octet_length(hls_output_prefix) BETWEEN 1 AND 1024),
  hls_master_key text CHECK (hls_master_key IS NULL OR octet_length(hls_master_key) BETWEEN 1 AND 1024),
  thumbnail_key text CHECK (thumbnail_key IS NULL OR octet_length(thumbnail_key) BETWEEN 1 AND 1024),
  failure_code text,
  failure_message text,
  queued_at timestamptz,
  transcoding_started_at timestamptz,
  ready_at timestamptz,
  failed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_run_id, version_no),
  UNIQUE (source_asset_id),
  CHECK (NOT is_current OR video_status = 'ready'),
  CHECK (video_status <> 'ready' OR (duration_seconds IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND hls_bucket_name IS NOT NULL AND hls_output_prefix IS NOT NULL AND hls_master_key IS NOT NULL AND thumbnail_key IS NOT NULL AND ready_at IS NOT NULL)),
  CHECK (video_status <> 'deleted' OR deleted_at IS NOT NULL)
);

CREATE UNIQUE INDEX course_video_versions_current_uq ON course_video_versions (course_run_id) WHERE is_current;
CREATE INDEX course_video_versions_run_status_idx ON course_video_versions (course_run_id, video_status, version_no DESC);
CREATE INDEX course_video_versions_queue_idx ON course_video_versions (queued_at, course_video_version_id) WHERE video_status IN ('queued', 'transcoding');
CREATE INDEX course_video_versions_cleanup_idx ON course_video_versions (updated_at, course_video_version_id) WHERE video_status = 'delete_pending';

CREATE FUNCTION course_video_version_source_matches_course() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM course_delivery_assets asset
    WHERE asset.course_delivery_asset_id = NEW.source_asset_id
      AND asset.course_run_id = NEW.course_run_id AND asset.asset_purpose = 'video_source') THEN
    RAISE EXCEPTION 'video source must be a video_source asset for the same course run';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION course_video_version_source_matches_course() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION course_video_version_source_matches_course() TO colearnx_app;
CREATE TRIGGER course_video_versions_source_check BEFORE INSERT OR UPDATE OF course_run_id, source_asset_id ON course_video_versions FOR EACH ROW EXECUTE FUNCTION course_video_version_source_matches_course();
-- Backfill only unambiguous legacy rows: an online-video course with exactly
-- one historical online_video asset whose stored object was already verified.
-- It is deliberately created as retryable_failed so the Worker must still
-- produce and validate HLS/thumbnail output. Existing orders are never bound.
-- Ambiguous or unverified assets retain online_video for manual reconciliation.
WITH eligible_legacy_video AS MATERIALIZED (
  SELECT asset.course_delivery_asset_id, asset.course_run_id
  FROM course_delivery_assets asset
  JOIN course_runs run ON run.course_run_id = asset.course_run_id
  WHERE asset.asset_purpose = 'online_video'
    AND asset.asset_status = 'ready'
    AND asset.verified_content_type LIKE 'video/%'
    AND asset.verified_byte_size > 0
    AND run.progress_tracking_type = 'online_video'
    AND NOT EXISTS (SELECT 1 FROM course_video_versions version WHERE version.course_run_id = asset.course_run_id)
    AND 1 = (SELECT count(*) FROM course_delivery_assets candidate
      WHERE candidate.course_run_id = asset.course_run_id AND candidate.asset_purpose = 'online_video')
), promoted_source AS (
  UPDATE course_delivery_assets asset
  SET asset_purpose = 'video_source', updated_at = now()
  FROM eligible_legacy_video eligible
  WHERE asset.course_delivery_asset_id = eligible.course_delivery_asset_id
  RETURNING asset.course_delivery_asset_id, asset.course_run_id
)
INSERT INTO course_video_versions
  (course_run_id, source_asset_id, version_no, video_status, failure_code, failure_message, failed_at)
SELECT course_run_id, course_delivery_asset_id, 1, 'failed', 'LEGACY_REPROCESS_REQUIRED',
  'Legacy source verified; retry processing to produce protected HLS and thumbnail output.', now()
FROM promoted_source
ON CONFLICT (source_asset_id) DO NOTHING;

ALTER TABLE order_items ADD COLUMN course_video_version_id uuid REFERENCES course_video_versions(course_video_version_id) ON DELETE RESTRICT;
CREATE INDEX order_items_course_video_version_idx ON order_items (course_video_version_id) WHERE course_video_version_id IS NOT NULL;

ALTER TABLE course_video_progress_sessions
  ADD COLUMN course_video_version_id uuid REFERENCES course_video_versions(course_video_version_id) ON DELETE RESTRICT,
  ADD COLUMN last_sequence integer NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  ADD COLUMN last_position_seconds numeric(12,3),
  ADD COLUMN last_playback_rate numeric(5,3),
  ADD COLUMN last_client_monotonic_ms numeric(16,3),
  ADD COLUMN last_event text CHECK (last_event IS NULL OR last_event IN ('playing', 'pause', 'seeking', 'seeked', 'ended')),
  ADD COLUMN last_heartbeat_at timestamptz,
  ADD COLUMN playback_expires_at timestamptz,
  ADD COLUMN session_status text NOT NULL DEFAULT 'active' CHECK (session_status IN ('active', 'expired', 'closed', 'revoked'));
CREATE INDEX course_video_progress_sessions_version_idx ON course_video_progress_sessions (order_item_id, course_video_version_id, updated_at DESC);
CREATE INDEX course_video_progress_sessions_video_version_fk_idx ON course_video_progress_sessions (course_video_version_id) WHERE course_video_version_id IS NOT NULL;

CREATE TABLE course_video_watch_intervals (
  course_video_watch_interval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id uuid NOT NULL REFERENCES order_items(order_item_id) ON DELETE RESTRICT,
  course_video_version_id uuid NOT NULL REFERENCES course_video_versions(course_video_version_id) ON DELETE RESTRICT,
  source_session_id uuid NOT NULL,
  interval_start_seconds numeric(12,3) NOT NULL CHECK (interval_start_seconds >= 0),
  interval_end_seconds numeric(12,3) NOT NULL CHECK (interval_end_seconds > interval_start_seconds),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (interval_end_seconds <= 14400)
);
CREATE INDEX course_video_watch_intervals_merge_idx ON course_video_watch_intervals (order_item_id, course_video_version_id, interval_start_seconds, interval_end_seconds);
CREATE INDEX course_video_watch_intervals_session_idx ON course_video_watch_intervals (source_session_id, confirmed_at DESC);
CREATE INDEX course_video_watch_intervals_video_version_fk_idx ON course_video_watch_intervals (course_video_version_id);
CREATE INDEX course_video_watch_intervals_session_fk_idx ON course_video_watch_intervals (order_item_id, course_video_version_id, source_session_id);

-- A watch interval is evidence for the version that the order actually bought,
-- and for a real session of that same order/version. Independent foreign keys
-- would otherwise allow cross-order progress to influence a refund.
ALTER TABLE order_items
  ADD CONSTRAINT order_items_order_video_version_uq UNIQUE (order_item_id, course_video_version_id);
ALTER TABLE course_video_progress_sessions
  ADD CONSTRAINT course_video_sessions_order_version_fk
    FOREIGN KEY (order_item_id, course_video_version_id)
    REFERENCES order_items (order_item_id, course_video_version_id) ON DELETE RESTRICT,
  ADD CONSTRAINT course_video_sessions_order_version_session_uq
    UNIQUE (order_item_id, course_video_version_id, session_id);
ALTER TABLE course_video_watch_intervals
  ADD CONSTRAINT course_video_intervals_order_version_fk
    FOREIGN KEY (order_item_id, course_video_version_id)
    REFERENCES order_items (order_item_id, course_video_version_id) ON DELETE RESTRICT,
  ADD CONSTRAINT course_video_intervals_session_fk
    FOREIGN KEY (order_item_id, course_video_version_id, source_session_id)
    REFERENCES course_video_progress_sessions (order_item_id, course_video_version_id, session_id) ON DELETE RESTRICT;
ALTER TABLE course_access_progress
  ALTER COLUMN watched_seconds TYPE numeric(12,3) USING watched_seconds::numeric(12,3),
  ALTER COLUMN total_seconds TYPE numeric(12,3) USING total_seconds::numeric(12,3),
  ALTER COLUMN watch_percent TYPE numeric(7,4) USING watch_percent::numeric(7,4);

GRANT SELECT, INSERT, UPDATE, DELETE ON course_video_versions TO colearnx_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON course_video_watch_intervals TO colearnx_app;

-- The media process is a separate deployment role. It receives only the
-- version state and object-metadata fields it must transition; it cannot read
-- or alter orders, points, refunds, or identity data. Role creation remains a
-- controlled deployment concern, so fresh developer databases without the
-- worker role can still apply this forward migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'colearnx_video_worker') THEN
    GRANT SELECT, UPDATE (video_status, is_current, duration_seconds, width, height,
      hls_bucket_name, hls_output_prefix, hls_master_key, thumbnail_key, failure_code,
      failure_message, queued_at, transcoding_started_at, ready_at, failed_at, deleted_at,
      updated_at) ON course_video_versions TO colearnx_video_worker;
    GRANT SELECT, UPDATE (asset_status, deleted_at, updated_at)
      ON course_delivery_assets TO colearnx_video_worker;
    GRANT SELECT, UPDATE (total_duration_seconds) ON course_runs TO colearnx_video_worker;
  END IF;
END;
$$;
