// Both queries use oi for the order item and o for its order. Keep the public
// lifetime counts and the publisher's date-filtered counts on the same basis.
export const eligibleSale = `o.paid_at IS NOT NULL AND oi.fulfilment_status NOT IN ('refunded', 'cancelled')`;

export const hasDownloadClaim = `CASE WHEN oi.item_type = 'course_run' THEN EXISTS (
  SELECT 1 FROM course_enrolments ce
  JOIN course_access_progress cap ON cap.enrolment_id = ce.enrolment_id
  WHERE ce.order_item_id = oi.order_item_id AND cap.download_completed_at IS NOT NULL
) ELSE EXISTS (
  SELECT 1 FROM content_access_grants cag
  WHERE cag.order_item_id = oi.order_item_id AND cag.first_accessed_at IS NOT NULL
) END`;

export function listingActivityColumn(kind: 'course' | 'content') {
  const product = kind === 'course'
    ? 'oi.course_run_id = cr.course_run_id'
    : 'oi.content_version_id = cv.content_version_id';
  // Keep "downloads" as the original order-based field for older clients.
  // Confirmed deliveries survive a later refund. Prior claims are never backfilled.
  return `(SELECT jsonb_build_object(
      'sales', count(*), 'downloads', count(*) FILTER (WHERE ${hasDownloadClaim}),
      'claimedOrders', count(*) FILTER (WHERE ${hasDownloadClaim}),
      'fileDownloads', (SELECT COALESCE(sum(oi.completed_file_downloads), 0)
        FROM order_items oi WHERE ${product} AND oi.completed_file_downloads > 0),
      'fileDownloadsSince', (SELECT started_at FROM file_download_tracking)
    ) FROM order_items oi JOIN orders o USING (order_id)
    WHERE ${product} AND ${eligibleSale}) AS activity`;
}
