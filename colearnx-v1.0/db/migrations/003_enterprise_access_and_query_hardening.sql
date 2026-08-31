-- This migration is intentionally schema-only: it contains no DML and does
-- not remove tables, columns, or user records. It hardens roles that are not
-- used by the running API and adds indexes for existing API query paths.

-- The migration ledger is deployment metadata, not application data.
REVOKE ALL PRIVILEGES ON TABLE schema_migrations
  FROM colearnx_app, colearnx_migrator, colearnx_readonly;

-- Migrations are run with the controlled owner connection. The legacy
-- colearnx_migrator login must not be a second broad data-access credential.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM colearnx_migrator;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM colearnx_migrator;
REVOKE CREATE ON SCHEMA public FROM colearnx_migrator;

-- Remove direct read access to credentials, session material, payment event
-- diagnostics, and personal/admin data from the reporting-only login.
REVOKE SELECT ON TABLE
  users,
  profiles,
  refresh_sessions,
  idempotency_records,
  stripe_payment_events,
  admin_action_logs,
  user_reports
  FROM colearnx_readonly;

-- The API receives only USAGE on the application schema. Prevent accidental
-- object creation through a compromised application or public connection.
REVOKE CREATE ON SCHEMA public FROM PUBLIC, colearnx_app, colearnx_readonly;

-- 001 granted future objects to the API role by default. New migrations must
-- now grant the least privileges they require explicitly.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM colearnx_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM colearnx_app;

-- Existing application queries: active delivery selection during checkout and
-- marketplace display.
CREATE INDEX course_delivery_options_active_run_delivery_idx
  ON course_delivery_options (course_run_id, delivery_type)
  WHERE option_status = 'active';

-- Existing application queries: capacity checks by course run.
CREATE INDEX course_enrolments_active_run_idx
  ON course_enrolments (course_run_id)
  WHERE enrolment_status IN ('active', 'confirmed', 'in_progress');

-- Existing application queries: a member's application history and the
-- administrator's pending review queue.
CREATE INDEX role_applications_applicant_submitted_idx
  ON role_applications (applicant_user_id, submitted_at DESC, application_id DESC);

CREATE INDEX role_applications_pending_review_idx
  ON role_applications (submitted_at DESC, application_id DESC)
  WHERE application_status = 'pending';

-- Existing application queries: release/cancellation of a live-course hold.
CREATE INDEX point_holds_active_purchase_idx
  ON point_holds (purchase_transaction_id)
  WHERE hold_status = 'active';
