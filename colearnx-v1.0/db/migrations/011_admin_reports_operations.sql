-- Reports & Operations is additive. Existing report records remain intact:
-- their unknown historical creation time and classification are represented by
-- NULL rather than being rewritten to the time this migration is deployed.

ALTER TABLE user_reports
  ADD COLUMN report_category text,
  ADD COLUMN created_at timestamptz,
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN decision_reason text,
  ADD COLUMN target_course_run_id uuid REFERENCES course_runs(course_run_id) ON DELETE RESTRICT,
  ADD COLUMN target_content_version_id uuid REFERENCES content_versions(content_version_id) ON DELETE RESTRICT,
  ADD COLUMN target_title_snapshot text;

ALTER TABLE user_reports
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET DEFAULT now();

-- NOT VALID keeps unverified historical rows readable while applying the new
-- invariants to every insert and update made after this migration.
ALTER TABLE user_reports
  ADD CONSTRAINT user_reports_status_v2_check
    CHECK (report_status IN ('pending', 'resolved', 'dismissed')) NOT VALID,
  ADD CONSTRAINT user_reports_category_check
    CHECK (report_category IS NULL OR report_category IN ('misleading', 'copyright', 'unsafe', 'other')) NOT VALID,
  ADD CONSTRAINT user_reports_course_target_consistency_check
    CHECK (created_at IS NULL OR (target_course_id IS NULL) = (target_course_run_id IS NULL)) NOT VALID,
  ADD CONSTRAINT user_reports_content_target_consistency_check
    CHECK (created_at IS NULL OR (target_content_id IS NULL) = (target_content_version_id IS NULL)) NOT VALID,
  ADD CONSTRAINT user_reports_review_state_check
    CHECK (
      (report_status = 'pending' AND reviewer_user_id IS NULL AND reviewed_at IS NULL AND decision_reason IS NULL)
      OR (report_status IN ('resolved', 'dismissed') AND reviewer_user_id IS NOT NULL AND reviewed_at IS NOT NULL AND decision_reason IS NOT NULL)
    ) NOT VALID;

CREATE INDEX user_reports_status_created_idx
  ON user_reports (report_status, created_at DESC, report_id DESC);
CREATE UNIQUE INDEX user_reports_pending_course_reporter_run_uq
  ON user_reports (reporter_user_id, target_course_run_id)
  WHERE report_status = 'pending' AND target_course_run_id IS NOT NULL;
CREATE UNIQUE INDEX user_reports_pending_content_reporter_version_uq
  ON user_reports (reporter_user_id, target_content_version_id)
  WHERE report_status = 'pending' AND target_content_version_id IS NOT NULL;
CREATE INDEX admin_action_logs_created_idx
  ON admin_action_logs (created_at DESC, log_id DESC);
