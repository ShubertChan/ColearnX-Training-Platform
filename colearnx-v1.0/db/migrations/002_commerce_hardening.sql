-- This migration is additive: 001 mirrors the team ERD V5.1 and is not
-- rewritten after it has been shared. These structures make the payment and
-- commerce invariants in the backend enforceable by PostgreSQL.

CREATE TABLE profiles (
  user_id uuid PRIMARY KEY REFERENCES users(user_id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(trim(display_name)) > 0),
  phone text,
  location text,
  bio text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orders
  ADD COLUMN receipt_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE order_items
  ADD COLUMN delivery_modes_snapshot_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN revenue_share_bps integer NOT NULL DEFAULT 10000
    CHECK (revenue_share_bps BETWEEN 0 AND 10000),
  ADD COLUMN revenue_share_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE point_accounts
  ADD COLUMN expired_balance bigint NOT NULL DEFAULT 0,
  ADD COLUMN blocked_balance bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT point_accounts_all_balances_nonnegative_check CHECK (
    account_status = 'system'
    OR (available_balance >= 0 AND frozen_balance >= 0 AND expired_balance >= 0 AND blocked_balance >= 0)
  );

ALTER TABLE point_ledger_entries
  ADD COLUMN expired_delta bigint NOT NULL DEFAULT 0,
  ADD COLUMN blocked_delta bigint NOT NULL DEFAULT 0,
  ADD COLUMN expired_balance_after bigint NOT NULL DEFAULT 0,
  ADD COLUMN blocked_balance_after bigint NOT NULL DEFAULT 0;
ALTER TABLE point_ledger_entries DROP CONSTRAINT IF EXISTS point_ledger_entries_check;
ALTER TABLE point_ledger_entries ADD CONSTRAINT point_ledger_entries_nonzero_delta_check
  CHECK (available_delta <> 0 OR frozen_delta <> 0 OR expired_delta <> 0 OR blocked_delta <> 0);

ALTER TABLE refund_requests
  ADD COLUMN policy_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN eligibility_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN resulting_point_transaction_id uuid REFERENCES point_transactions(point_transaction_id) ON DELETE RESTRICT;

CREATE TABLE revenue_share_policies (
  revenue_share_policy_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_kind text NOT NULL CHECK (product_kind IN ('course_run', 'content_version')),
  policy_code text NOT NULL UNIQUE,
  platform_share_bps integer NOT NULL CHECK (platform_share_bps BETWEEN 0 AND 10000),
  trainer_share_bps integer NOT NULL DEFAULT 0 CHECK (trainer_share_bps BETWEEN 0 AND 10000),
  creator_share_bps integer NOT NULL DEFAULT 0 CHECK (creator_share_bps BETWEEN 0 AND 10000),
  is_active boolean NOT NULL DEFAULT false,
  effective_from timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CHECK (
    (product_kind = 'course_run' AND platform_share_bps + trainer_share_bps = 10000 AND creator_share_bps = 0)
    OR (product_kind = 'content_version' AND platform_share_bps + creator_share_bps = 10000 AND trainer_share_bps = 0)
  )
);
CREATE UNIQUE INDEX revenue_share_policies_active_kind_uq
  ON revenue_share_policies (product_kind) WHERE is_active AND retired_at IS NULL;

CREATE TABLE earnings_allocations (
  earnings_allocation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id uuid NOT NULL REFERENCES order_items(order_item_id) ON DELETE RESTRICT,
  recipient_kind text NOT NULL CHECK (recipient_kind IN ('platform', 'trainer', 'creator')),
  recipient_user_id uuid REFERENCES users(user_id) ON DELETE RESTRICT,
  share_bps integer NOT NULL CHECK (share_bps BETWEEN 0 AND 10000),
  points_amount bigint NOT NULL CHECK (points_amount >= 0),
  allocation_status text NOT NULL DEFAULT 'pending'
    CHECK (allocation_status IN ('pending', 'settled', 'reversed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (recipient_kind = 'platform' AND recipient_user_id IS NULL)
    OR (recipient_kind IN ('trainer', 'creator') AND recipient_user_id IS NOT NULL)
  ),
  UNIQUE NULLS NOT DISTINCT (order_item_id, recipient_kind, recipient_user_id)
);
CREATE INDEX earnings_allocations_recipient_status_idx
  ON earnings_allocations (recipient_user_id, allocation_status, created_at DESC);

CREATE OR REPLACE FUNCTION enforce_earnings_share_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected_order_item_id uuid := COALESCE(NEW.order_item_id, OLD.order_item_id);
  total_bps integer;
BEGIN
  SELECT COALESCE(sum(share_bps), 0) INTO total_bps
  FROM earnings_allocations
  WHERE order_item_id = affected_order_item_id;

  IF total_bps <> 10000 THEN
    RAISE EXCEPTION 'Earnings shares for order item % must total 10000 bps', affected_order_item_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER earnings_allocations_share_total_check
AFTER INSERT OR UPDATE OR DELETE ON earnings_allocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_earnings_share_total();

CREATE OR REPLACE FUNCTION enforce_point_transaction_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected_transaction_id uuid := COALESCE(NEW.point_transaction_id, OLD.point_transaction_id);
  net_points bigint;
BEGIN
  SELECT COALESCE(sum(available_delta + frozen_delta + expired_delta + blocked_delta), 0) INTO net_points
  FROM point_ledger_entries
  WHERE point_transaction_id = affected_transaction_id;

  IF net_points <> 0 THEN
    RAISE EXCEPTION 'Point transaction % is not balanced', affected_transaction_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER point_ledger_entries_balanced_check
AFTER INSERT OR UPDATE OR DELETE ON point_ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_point_transaction_balance();

CREATE INDEX point_topup_orders_account_created_idx
  ON point_topup_orders (point_account_id, created_at DESC, topup_order_id DESC);
CREATE INDEX payment_transactions_topup_order_idx
  ON payment_transactions (topup_order_id);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX course_enrolments_order_item_idx ON course_enrolments (order_item_id);
CREATE INDEX content_access_grants_user_idx ON content_access_grants (user_id, granted_at DESC);
CREATE INDEX stripe_payment_events_payment_idx
  ON stripe_payment_events (payment_transaction_id, received_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON profiles, revenue_share_policies, earnings_allocations TO colearnx_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON profiles, revenue_share_policies, earnings_allocations TO colearnx_migrator;
GRANT SELECT ON profiles, revenue_share_policies, earnings_allocations TO colearnx_readonly;
