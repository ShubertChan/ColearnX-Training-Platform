-- Bound the per-account velocity check to the recent credited orders.
CREATE INDEX point_topup_orders_account_credited_idx
  ON point_topup_orders (point_account_id, credited_at DESC)
  WHERE topup_status = 'paid' AND credited_at IS NOT NULL;
