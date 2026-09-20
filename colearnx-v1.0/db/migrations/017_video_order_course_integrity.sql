-- A video order must bind to a version of the same course run. The original
-- single-column FK proved the version existed but still allowed a cross-course
-- association through direct SQL or a future application regression.
ALTER TABLE course_video_versions
  ADD COLUMN processing_attempt_id uuid,
  ADD CONSTRAINT course_video_versions_id_course_uq
  UNIQUE (course_video_version_id, course_run_id);

ALTER TABLE order_items
  ADD CONSTRAINT order_items_video_version_course_item_ck
  CHECK (course_video_version_id IS NULL
    OR (item_type = 'course_run' AND course_run_id IS NOT NULL)),
  ADD CONSTRAINT order_items_video_version_course_fk
  FOREIGN KEY (course_video_version_id, course_run_id)
  REFERENCES course_video_versions (course_video_version_id, course_run_id)
  ON DELETE RESTRICT;

-- Purchases are snapshots. Even another version of the same course must not
-- replace the version that was bound when the order item was inserted.
CREATE FUNCTION reject_order_video_version_rebinding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.course_video_version_id IS DISTINCT FROM NEW.course_video_version_id THEN
    RAISE EXCEPTION 'purchased video version is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION reject_order_video_version_rebinding() FROM PUBLIC;
CREATE TRIGGER order_items_video_version_immutable
BEFORE UPDATE OF course_video_version_id ON order_items
FOR EACH ROW EXECUTE FUNCTION reject_order_video_version_rebinding();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'colearnx_video_worker') THEN
    GRANT SELECT, UPDATE (processing_attempt_id) ON course_video_versions TO colearnx_video_worker;
  END IF;
END;
$$;

-- Before attempt fencing, non-terminal failures were immediately returned to
-- queued; therefore a persisted failed/TRANSCODE_FAILED row is an exhausted
-- job and can be classified deterministically for the new operations API.
UPDATE course_video_versions
SET failure_code = 'TRANSCODE_RETRIES_EXHAUSTED',
    failure_message = 'Processing failed after all automatic retries.',
    updated_at = now()
WHERE video_status = 'failed' AND failure_code = 'TRANSCODE_FAILED';
