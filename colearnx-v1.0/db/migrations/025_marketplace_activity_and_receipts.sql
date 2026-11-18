-- The catalogue shows activity for a specific sellable run/version.
CREATE INDEX order_items_catalog_course_idx ON order_items (course_run_id)
  WHERE course_run_id IS NOT NULL AND fulfilment_status NOT IN ('refunded', 'cancelled');
CREATE INDEX order_items_catalog_content_idx ON order_items (content_version_id)
  WHERE content_version_id IS NOT NULL AND fulfilment_status NOT IN ('refunded', 'cancelled');

-- Receipts keep the original purchase or reservation even after a refund.
CREATE INDEX point_transactions_receipt_idx
  ON point_transactions (order_item_id, created_at, point_transaction_id)
  WHERE transaction_type IN ('purchase', 'live_hold');
