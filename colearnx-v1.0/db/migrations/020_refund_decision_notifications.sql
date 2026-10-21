-- Keep a refund result until its owner explicitly acknowledges the popup.
ALTER TABLE notifications
  ADD COLUMN refund_request_id uuid REFERENCES refund_requests(refund_request_id) ON DELETE RESTRICT,
  ADD CONSTRAINT notifications_refund_request_unique UNIQUE (refund_request_id);

CREATE INDEX notifications_unread_refunds_idx
  ON notifications (user_id, created_at, notification_id)
  WHERE notification_type = 'refund_decision' AND is_read = false;
