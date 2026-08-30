CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  user_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL CHECK (length(trim(full_name)) > 0),
  email citext NOT NULL,
  password_hash text NOT NULL,
  account_status text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'suspended', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_normalized_uq ON users (lower(email::text));

CREATE TABLE roles (
  role_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_code text NOT NULL UNIQUE CHECK (role_code IN ('member', 'trainer', 'creator', 'admin')),
  role_name text NOT NULL,
  description text NOT NULL
);

CREATE TABLE user_roles (
  user_role_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  role_id uuid NOT NULL REFERENCES roles(role_id) ON DELETE RESTRICT,
  assigned_by_user_id uuid REFERENCES users(user_id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX user_roles_active_uq ON user_roles (user_id, role_id) WHERE revoked_at IS NULL;

CREATE TABLE refresh_sessions (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoke_reason text,
  replaced_by_session_id uuid REFERENCES refresh_sessions(session_id) ON DELETE RESTRICT,
  user_agent text,
  ip_hash text,
  CHECK (expires_at > created_at)
);
CREATE INDEX refresh_sessions_active_user_idx ON refresh_sessions (user_id, expires_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE role_applications (
  application_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  requested_role_id uuid NOT NULL REFERENCES roles(role_id) ON DELETE RESTRICT,
  application_status text NOT NULL DEFAULT 'pending' CHECK (application_status IN ('pending', 'approved', 'rejected')),
  supporting_text text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewer_user_id uuid REFERENCES users(user_id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_comment text
);
CREATE UNIQUE INDEX role_applications_pending_uq ON role_applications (applicant_user_id, requested_role_id) WHERE application_status = 'pending';

CREATE TABLE categories (
  category_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_name text NOT NULL UNIQUE,
  category_scope text NOT NULL CHECK (category_scope IN ('course', 'content', 'both')),
  parent_category_id uuid REFERENCES categories(category_id) ON DELETE RESTRICT
);

CREATE TABLE tags (
  tag_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_name text NOT NULL UNIQUE
);

CREATE TABLE refund_policies (
  refund_policy_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_code text NOT NULL UNIQUE,
  target_type text NOT NULL CHECK (target_type IN ('course_run', 'content')),
  primary_delivery_type text NOT NULL CHECK (primary_delivery_type IN ('cloud', 'local', 'live', 'record')),
  purchase_window_hours integer CHECK (purchase_window_hours IS NULL OR purchase_window_hours >= 0),
  minimum_hours_before_start integer CHECK (minimum_hours_before_start IS NULL OR minimum_hours_before_start >= 0),
  maximum_watch_percent numeric(5,2) CHECK (maximum_watch_percent IS NULL OR maximum_watch_percent BETWEEN 0 AND 100),
  first_access_blocks_refund boolean NOT NULL DEFAULT false,
  deny_after_download boolean NOT NULL DEFAULT false,
  policy_status text NOT NULL DEFAULT 'active' CHECK (policy_status IN ('draft', 'active', 'retired')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz
);

CREATE TABLE contents (
  content_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  category_id uuid REFERENCES categories(category_id) ON DELETE RESTRICT,
  refund_policy_id uuid REFERENCES refund_policies(refund_policy_id) ON DELETE RESTRICT,
  content_type text NOT NULL,
  title text NOT NULL CHECK (length(trim(title)) > 0),
  price_points bigint NOT NULL CHECK (price_points >= 0),
  publication_status text NOT NULL DEFAULT 'draft' CHECK (publication_status IN ('draft', 'submitted', 'approved', 'published', 'rejected', 'archived')),
  search_vector tsvector GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(title, '')), 'A')) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contents_marketplace_idx ON contents (created_at DESC, content_id DESC) WHERE publication_status = 'published';
CREATE INDEX contents_search_idx ON contents USING gin (search_vector);

CREATE TABLE content_versions (
  content_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id uuid NOT NULL REFERENCES contents(content_id) ON DELETE RESTRICT,
  version_no integer NOT NULL CHECK (version_no > 0),
  storage_url text,
  version_status text NOT NULL DEFAULT 'draft' CHECK (version_status IN ('draft', 'submitted', 'approved', 'published', 'rejected', 'retired')),
  published_at timestamptz,
  UNIQUE (content_id, version_no)
);
CREATE UNIQUE INDEX content_versions_current_published_uq ON content_versions (content_id) WHERE version_status = 'published';

CREATE TABLE content_tags (
  content_tag_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id uuid NOT NULL REFERENCES contents(content_id) ON DELETE RESTRICT,
  tag_id uuid NOT NULL REFERENCES tags(tag_id) ON DELETE RESTRICT,
  UNIQUE (content_id, tag_id)
);

CREATE TABLE courses (
  course_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  category_id uuid REFERENCES categories(category_id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(trim(title)) > 0),
  description text NOT NULL DEFAULT '',
  course_level text,
  certificate_enabled boolean NOT NULL DEFAULT false,
  publication_status text NOT NULL DEFAULT 'draft' CHECK (publication_status IN ('draft', 'submitted', 'approved', 'published', 'rejected', 'archived')),
  search_vector tsvector GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(description, '')), 'B')) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX courses_search_idx ON courses USING gin (search_vector);

CREATE TABLE course_tags (
  course_tag_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(course_id) ON DELETE RESTRICT,
  tag_id uuid NOT NULL REFERENCES tags(tag_id) ON DELETE RESTRICT,
  UNIQUE (course_id, tag_id)
);

CREATE TABLE course_modules (
  module_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(course_id) ON DELETE RESTRICT,
  module_title text NOT NULL,
  module_order integer NOT NULL CHECK (module_order > 0),
  learning_outcome text,
  assessment_required boolean NOT NULL DEFAULT false,
  UNIQUE (course_id, module_order)
);

CREATE TABLE course_runs (
  course_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(course_id) ON DELETE RESTRICT,
  refund_policy_id uuid REFERENCES refund_policies(refund_policy_id) ON DELETE RESTRICT,
  run_code text NOT NULL UNIQUE,
  run_status text NOT NULL DEFAULT 'draft' CHECK (run_status IN ('draft', 'submitted', 'approved', 'published', 'cancelled', 'completed', 'archived')),
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text,
  capacity integer CHECK (capacity IS NULL OR capacity > 0),
  price_points bigint NOT NULL CHECK (price_points >= 0),
  primary_delivery_type text NOT NULL CHECK (primary_delivery_type IN ('cloud', 'local', 'live', 'record')),
  recording_status text,
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX course_runs_marketplace_idx ON course_runs (starts_at, course_run_id) WHERE run_status = 'published';

CREATE TABLE course_delivery_options (
  delivery_option_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_run_id uuid NOT NULL REFERENCES course_runs(course_run_id) ON DELETE RESTRICT,
  delivery_type text NOT NULL CHECK (delivery_type IN ('cloud', 'local', 'live', 'record')),
  access_mode text NOT NULL,
  asset_reference text,
  available_from timestamptz,
  available_until timestamptz,
  is_primary boolean NOT NULL DEFAULT false,
  option_status text NOT NULL DEFAULT 'active' CHECK (option_status IN ('draft', 'active', 'disabled')),
  CHECK (available_until IS NULL OR available_from IS NULL OR available_until > available_from)
);
CREATE UNIQUE INDEX course_delivery_options_primary_uq ON course_delivery_options (course_run_id) WHERE is_primary;

CREATE TABLE course_sessions (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_run_id uuid NOT NULL REFERENCES course_runs(course_run_id) ON DELETE RESTRICT,
  session_type text NOT NULL,
  session_status text NOT NULL DEFAULT 'scheduled' CHECK (session_status IN ('scheduled', 'cancelled', 'completed')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  timezone text,
  venue text,
  external_meeting_url text,
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE course_run_trainers (
  run_trainer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_run_id uuid NOT NULL REFERENCES course_runs(course_run_id) ON DELETE RESTRICT,
  trainer_user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  trainer_role text NOT NULL,
  UNIQUE (course_run_id, trainer_user_id)
);

-- Additive operational table: the presentation ERD models trainer access through
-- roles.  This table keeps the auditable certification/review workflow required
-- for creators to publish trainer-led offerings without renaming any ERD entity.
CREATE TABLE trainer_certifications (
  trainer_certification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  certification_name text NOT NULL,
  certification_reference text,
  evidence_url text,
  certification_status text NOT NULL DEFAULT 'pending' CHECK (certification_status IN ('pending', 'approved', 'rejected', 'expired')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by_user_id uuid REFERENCES users(user_id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_comment text
);
CREATE INDEX trainer_certifications_user_status_idx ON trainer_certifications (trainer_user_id, certification_status);

CREATE TABLE course_module_contents (
  module_content_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id uuid NOT NULL REFERENCES course_modules(module_id) ON DELETE RESTRICT,
  content_version_id uuid REFERENCES content_versions(content_version_id) ON DELETE RESTRICT,
  content_license_id uuid,
  display_order integer NOT NULL CHECK (display_order > 0),
  is_required boolean NOT NULL DEFAULT true,
  UNIQUE (module_id, display_order)
);

CREATE TABLE orders (
  order_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  order_no text NOT NULL UNIQUE,
  order_status text NOT NULL DEFAULT 'paid' CHECK (order_status IN ('pending', 'paid', 'partially_refunded', 'refunded', 'cancelled')),
  total_points bigint NOT NULL CHECK (total_points >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_buyer_created_idx ON orders (buyer_user_id, created_at DESC, order_id DESC);

CREATE TABLE order_items (
  order_item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(order_id) ON DELETE RESTRICT,
  item_type text NOT NULL CHECK (item_type IN ('course_run', 'content_version')),
  course_run_id uuid REFERENCES course_runs(course_run_id) ON DELETE RESTRICT,
  content_version_id uuid REFERENCES content_versions(content_version_id) ON DELETE RESTRICT,
  seller_user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  item_title_snapshot text NOT NULL,
  points_amount bigint NOT NULL CHECK (points_amount >= 0),
  refund_policy_id uuid REFERENCES refund_policies(refund_policy_id) ON DELETE RESTRICT,
  refund_policy_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  refund_deadline_at timestamptz,
  fulfilment_status text NOT NULL DEFAULT 'paid' CHECK (fulfilment_status IN ('paid', 'reserved', 'fulfilled', 'refunded', 'cancelled')),
  CHECK ((course_run_id IS NOT NULL)::integer + (content_version_id IS NOT NULL)::integer = 1)
);

CREATE TABLE course_enrolments (
  enrolment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_run_id uuid NOT NULL REFERENCES course_runs(course_run_id) ON DELETE RESTRICT,
  learner_user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  order_item_id uuid NOT NULL UNIQUE REFERENCES order_items(order_item_id) ON DELETE RESTRICT,
  enrolment_status text NOT NULL DEFAULT 'active' CHECK (enrolment_status IN ('active', 'confirmed', 'in_progress', 'completed', 'cancelled', 'refunded')),
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  transfer_to_user_id uuid REFERENCES users(user_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX course_enrolments_active_uq ON course_enrolments (course_run_id, learner_user_id) WHERE enrolment_status IN ('active', 'confirmed', 'in_progress');

CREATE TABLE learning_progress (
  progress_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id uuid NOT NULL REFERENCES course_enrolments(enrolment_id) ON DELETE RESTRICT,
  module_id uuid NOT NULL REFERENCES course_modules(module_id) ON DELETE RESTRICT,
  progress_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  progress_status text NOT NULL DEFAULT 'not_started',
  score numeric(7,2),
  completed_at timestamptz,
  UNIQUE (enrolment_id, module_id)
);

CREATE TABLE course_access_progress (
  access_progress_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id uuid NOT NULL REFERENCES course_enrolments(enrolment_id) ON DELETE RESTRICT,
  delivery_option_id uuid NOT NULL REFERENCES course_delivery_options(delivery_option_id) ON DELETE RESTRICT,
  first_started_at timestamptz,
  last_watched_at timestamptz,
  watched_seconds integer NOT NULL DEFAULT 0 CHECK (watched_seconds >= 0),
  total_seconds integer CHECK (total_seconds IS NULL OR total_seconds >= 0),
  watch_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (watch_percent BETWEEN 0 AND 100),
  live_attendance_status text,
  download_completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enrolment_id, delivery_option_id)
);

CREATE TABLE content_access_grants (
  access_grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_version_id uuid NOT NULL REFERENCES content_versions(content_version_id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  order_item_id uuid NOT NULL UNIQUE REFERENCES order_items(order_item_id) ON DELETE RESTRICT,
  grant_reason text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  first_accessed_at timestamptz,
  UNIQUE (content_version_id, user_id)
);

CREATE TABLE content_licenses (
  content_license_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_version_id uuid NOT NULL REFERENCES content_versions(content_version_id) ON DELETE RESTRICT,
  order_item_id uuid REFERENCES order_items(order_item_id) ON DELETE RESTRICT,
  buyer_user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  creator_user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  license_code text NOT NULL UNIQUE,
  license_terms_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_until timestamptz
);
ALTER TABLE course_module_contents ADD CONSTRAINT course_module_contents_license_fk FOREIGN KEY (content_license_id) REFERENCES content_licenses(content_license_id) ON DELETE RESTRICT;

CREATE TABLE course_feedback (
  feedback_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id uuid NOT NULL UNIQUE REFERENCES course_enrolments(enrolment_id) ON DELETE RESTRICT,
  questionnaire_version text NOT NULL,
  trainer_score integer CHECK (trainer_score BETWEEN 1 AND 5),
  design_score integer CHECK (design_score BETWEEN 1 AND 5),
  practical_value_score integer CHECK (practical_value_score BETWEEN 1 AND 5),
  immutable_after_submit boolean NOT NULL DEFAULT true,
  submitted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credentials (
  credential_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid REFERENCES courses(course_id) ON DELETE RESTRICT,
  module_id uuid REFERENCES course_modules(module_id) ON DELETE RESTRICT,
  credential_title text NOT NULL,
  credential_type text NOT NULL,
  issuer_name text NOT NULL,
  criteria_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (course_id IS NOT NULL OR module_id IS NOT NULL)
);

CREATE TABLE issued_credentials (
  issued_credential_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid NOT NULL REFERENCES credentials(credential_id) ON DELETE RESTRICT,
  enrolment_id uuid NOT NULL REFERENCES course_enrolments(enrolment_id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  credential_no text NOT NULL UNIQUE,
  credential_status text NOT NULL DEFAULT 'issued',
  issued_at timestamptz NOT NULL DEFAULT now(),
  batch_no text,
  blockchain_hash text
);

CREATE TABLE point_accounts (
  point_account_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(user_id) ON DELETE RESTRICT,
  available_balance bigint NOT NULL DEFAULT 0,
  frozen_balance bigint NOT NULL DEFAULT 0,
  account_status text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'restricted', 'closed', 'system')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((account_status = 'system') OR (available_balance >= 0 AND frozen_balance >= 0))
);
CREATE UNIQUE INDEX point_accounts_user_active_uq ON point_accounts (user_id) WHERE user_id IS NOT NULL AND account_status IN ('active', 'restricted');

CREATE TABLE point_topup_packages (
  point_topup_package_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_code text NOT NULL UNIQUE,
  display_name text NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[a-z]{3}$'),
  fiat_amount bigint NOT NULL CHECK (fiat_amount > 0),
  points_amount bigint NOT NULL CHECK (points_amount > 0),
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);

CREATE TABLE payment_channels (
  payment_channel_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_code text NOT NULL UNIQUE,
  channel_type text NOT NULL,
  provider_code text NOT NULL,
  display_name text NOT NULL,
  is_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE point_topup_orders (
  topup_order_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  point_account_id uuid NOT NULL REFERENCES point_accounts(point_account_id) ON DELETE RESTRICT,
  points_amount bigint NOT NULL CHECK (points_amount > 0),
  fiat_amount bigint NOT NULL CHECK (fiat_amount > 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[a-z]{3}$'),
  topup_no text NOT NULL UNIQUE,
  topup_status text NOT NULL DEFAULT 'pending' CHECK (topup_status IN ('pending', 'checkout_created', 'paid', 'failed', 'expired', 'manual_review')),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  credited_at timestamptz
);

CREATE TABLE payment_transactions (
  payment_transaction_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topup_order_id uuid NOT NULL REFERENCES point_topup_orders(topup_order_id) ON DELETE RESTRICT,
  payment_channel_id uuid NOT NULL REFERENCES payment_channels(payment_channel_id) ON DELETE RESTRICT,
  amount bigint NOT NULL CHECK (amount > 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[a-z]{3}$'),
  payment_status text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'checkout_created', 'paid', 'failed', 'expired', 'manual_review')),
  provider_transaction_id text UNIQUE,
  idempotency_key text NOT NULL UNIQUE,
  requested_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  failure_code text
);

CREATE TABLE payment_refunds (
  payment_refund_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_transaction_id uuid NOT NULL REFERENCES payment_transactions(payment_transaction_id) ON DELETE RESTRICT,
  admin_action_log_id uuid,
  amount bigint NOT NULL CHECK (amount > 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[a-z]{3}$'),
  provider_refund_id text UNIQUE,
  refund_reason text NOT NULL,
  refund_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE refund_requests (
  refund_request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id uuid NOT NULL REFERENCES order_items(order_item_id) ON DELETE RESTRICT,
  requested_by_user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  requested_points bigint NOT NULL CHECK (requested_points >= 0),
  refund_reason text NOT NULL,
  refund_status text NOT NULL DEFAULT 'pending' CHECK (refund_status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by_user_id uuid REFERENCES users(user_id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  decision_note text,
  approved_points bigint,
  eligibility_code text,
  watch_percent_snapshot numeric(5,2),
  first_accessed_at_snapshot timestamptz,
  download_completed_at_snapshot timestamptz
);
CREATE UNIQUE INDEX refund_requests_pending_item_uq ON refund_requests (order_item_id) WHERE refund_status = 'pending';

CREATE TABLE point_transactions (
  point_transaction_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_type text NOT NULL CHECK (transaction_type IN ('topup', 'purchase', 'live_hold', 'live_settlement', 'refund', 'admin_adjustment')),
  transaction_status text NOT NULL DEFAULT 'posted' CHECK (transaction_status = 'posted'),
  reason text NOT NULL,
  idempotency_key text UNIQUE,
  topup_order_id uuid REFERENCES point_topup_orders(topup_order_id) ON DELETE RESTRICT,
  order_item_id uuid REFERENCES order_items(order_item_id) ON DELETE RESTRICT,
  refund_request_id uuid REFERENCES refund_requests(refund_request_id) ON DELETE RESTRICT,
  reversal_of_transaction_id uuid REFERENCES point_transactions(point_transaction_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX point_transactions_created_idx ON point_transactions (created_at DESC, point_transaction_id DESC);

CREATE TABLE point_ledger_entries (
  ledger_entry_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  point_transaction_id uuid NOT NULL REFERENCES point_transactions(point_transaction_id) ON DELETE RESTRICT,
  point_account_id uuid NOT NULL REFERENCES point_accounts(point_account_id) ON DELETE RESTRICT,
  entry_role text NOT NULL,
  available_delta bigint NOT NULL DEFAULT 0,
  frozen_delta bigint NOT NULL DEFAULT 0,
  available_balance_after bigint NOT NULL,
  frozen_balance_after bigint NOT NULL,
  immutable boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (available_delta <> 0 OR frozen_delta <> 0)
);
CREATE INDEX point_ledger_entries_account_created_idx ON point_ledger_entries (point_account_id, created_at DESC, ledger_entry_id DESC);

CREATE TABLE point_holds (
  point_hold_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_account_id uuid REFERENCES point_accounts(point_account_id) ON DELETE RESTRICT,
  purchase_transaction_id uuid NOT NULL REFERENCES point_transactions(point_transaction_id) ON DELETE RESTRICT,
  release_transaction_id uuid REFERENCES point_transactions(point_transaction_id) ON DELETE RESTRICT,
  points_amount bigint NOT NULL CHECK (points_amount > 0),
  hold_status text NOT NULL DEFAULT 'active' CHECK (hold_status IN ('active', 'released', 'cancelled')),
  release_trigger text,
  release_at timestamptz,
  released_at timestamptz,
  cancelled_at timestamptz
);

CREATE TABLE admin_action_logs (
  log_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(user_id) ON DELETE RESTRICT,
  action_type text NOT NULL,
  target_table text NOT NULL,
  target_record_id text NOT NULL,
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_ip text,
  request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE payment_refunds ADD CONSTRAINT payment_refunds_admin_log_fk FOREIGN KEY (admin_action_log_id) REFERENCES admin_action_logs(log_id) ON DELETE RESTRICT;

CREATE TABLE carts (
  cart_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  cart_status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX carts_active_buyer_uq ON carts (buyer_user_id) WHERE cart_status = 'active';

CREATE TABLE cart_items (
  cart_item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL REFERENCES carts(cart_id) ON DELETE RESTRICT,
  item_type text NOT NULL CHECK (item_type IN ('course_run', 'content_version')),
  course_run_id uuid REFERENCES course_runs(course_run_id) ON DELETE RESTRICT,
  content_version_id uuid REFERENCES content_versions(content_version_id) ON DELETE RESTRICT,
  points_snapshot bigint NOT NULL CHECK (points_snapshot >= 0),
  CHECK ((course_run_id IS NOT NULL)::integer + (content_version_id IS NOT NULL)::integer = 1)
);

CREATE TABLE notifications (
  notification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  notification_type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

CREATE TABLE user_reports (
  report_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  target_user_id uuid REFERENCES users(user_id) ON DELETE RESTRICT,
  target_course_id uuid REFERENCES courses(course_id) ON DELETE RESTRICT,
  target_content_id uuid REFERENCES contents(content_id) ON DELETE RESTRICT,
  reason text NOT NULL,
  report_status text NOT NULL DEFAULT 'pending',
  reviewer_user_id uuid REFERENCES users(user_id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  CHECK ((target_user_id IS NOT NULL)::integer + (target_course_id IS NOT NULL)::integer + (target_content_id IS NOT NULL)::integer = 1)
);

CREATE TABLE stripe_payment_events (
  stripe_event_id text PRIMARY KEY,
  payment_transaction_id uuid REFERENCES payment_transactions(payment_transaction_id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  payload_sha256 text NOT NULL,
  processing_status text NOT NULL DEFAULT 'received' CHECK (processing_status IN ('received', 'processed', 'ignored', 'failed')),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  diagnostic_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE idempotency_records (
  idempotency_record_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  operation_scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (actor_user_id, operation_scope, idempotency_key)
);

CREATE TABLE outbox_events (
  outbox_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
CREATE INDEX outbox_events_pending_idx ON outbox_events (created_at) WHERE processed_at IS NULL;

CREATE OR REPLACE FUNCTION reject_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Immutable business record: % cannot be modified or deleted', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER point_transactions_immutable BEFORE UPDATE OR DELETE ON point_transactions FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER point_ledger_entries_immutable BEFORE UPDATE OR DELETE ON point_ledger_entries FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER admin_action_logs_immutable BEFORE UPDATE OR DELETE ON admin_action_logs FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

GRANT USAGE ON SCHEMA public TO colearnx_app, colearnx_migrator, colearnx_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO colearnx_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO colearnx_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO colearnx_migrator;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO colearnx_migrator;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO colearnx_readonly;
REVOKE UPDATE, DELETE ON point_transactions, point_ledger_entries, admin_action_logs FROM colearnx_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO colearnx_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO colearnx_app;
