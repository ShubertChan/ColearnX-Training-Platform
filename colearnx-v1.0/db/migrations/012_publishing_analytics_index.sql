-- Publisher analytics filters order items by seller and item type before
-- joining paid orders in the requested reporting range. Refunded and cancelled
-- items never appear in publisher sales totals, so a partial index keeps the
-- common reporting path compact.
CREATE INDEX order_items_publisher_analytics_idx
  ON order_items (seller_user_id, item_type, order_id)
  WHERE fulfilment_status NOT IN ('refunded', 'cancelled');
