import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { eligibleSale, hasDownloadClaim } from '../catalog/listing-activity.js';
import { ok } from '../lib/http.js';
import { resolveUtcDateRange } from '../lib/reporting-dates.js';
import { optionalReportingDate, safeMetric, withReadOnlySnapshot } from '../lib/reporting-query.js';
import { parse } from '../lib/validation.js';

const publishingAnalyticsInput = z.object({
  kind: z.enum(['course', 'content']),
  from: optionalReportingDate,
  to: optionalReportingDate,
}).strict();

type TotalRow = { sales: string; revenue_points: string; downloads: string; file_downloads: string };
type ItemRow = TotalRow & { id: string; title: string };

function metricsQuery(groupBy = false) {
  return `WITH owned_items AS (
    SELECT oi.order_item_id,
      COALESCE(oi.course_run_id, oi.content_version_id)::text AS id,
      oi.item_title_snapshot AS title,
      COALESCE((SELECT sum(e.points_amount) FROM earnings_allocations e
        WHERE e.order_item_id = oi.order_item_id AND e.recipient_user_id = $1
          AND e.allocation_status <> 'reversed'), 0) AS revenue_points,
      ${eligibleSale} AS eligible, ${hasDownloadClaim} AS claimed, oi.completed_file_downloads
    FROM order_items oi
    JOIN orders o ON o.order_id = oi.order_id
    WHERE oi.seller_user_id = $1
      AND oi.item_type = $2
      AND ((${eligibleSale}) OR oi.completed_file_downloads > 0)
      AND o.paid_at >= ($3::date::timestamp AT TIME ZONE 'UTC')
      AND o.paid_at < (($4::date + 1)::timestamp AT TIME ZONE 'UTC')
  )
  SELECT ${groupBy ? 'id, title,' : ''}
    count(*) FILTER (WHERE eligible)::text AS sales,
    COALESCE(sum(revenue_points::bigint) FILTER (WHERE eligible), 0)::text AS revenue_points,
    count(*) FILTER (WHERE eligible AND claimed)::text AS downloads,
    COALESCE(sum(completed_file_downloads), 0)::text AS file_downloads
  FROM owned_items
  ${groupBy ? 'GROUP BY id, title ORDER BY count(*) FILTER (WHERE eligible) DESC, sum(revenue_points::bigint) FILTER (WHERE eligible) DESC NULLS LAST, title ASC LIMIT 100' : ''}`;
}

export async function publishingAnalytics(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(publishingAnalyticsInput, req.query);
  const range = resolveUtcDateRange(input);
  const itemType = input.kind === 'course' ? 'course_run' : 'content_version';
  const snapshot = await withReadOnlySnapshot(async (client) => {
    const params = [actor.id, itemType, range.from, range.to];
    const asOfResult = await client.query<{ as_of: Date; started_at: Date }>('SELECT now() AS as_of, started_at FROM file_download_tracking');
    const totals = await client.query<TotalRow>(metricsQuery(), params);
    const items = await client.query<ItemRow>(metricsQuery(true), params);
    return { asOf: asOfResult.rows[0].as_of, since: asOfResult.rows[0].started_at, totals: totals.rows[0], items: items.rows };
  });

  const totals = snapshot.totals ?? { sales: '0', revenue_points: '0', downloads: '0', file_downloads: '0' };
  return ok(res, {
    sales: safeMetric(totals.sales, 'sales'),
    revenuePoints: safeMetric(totals.revenue_points, 'revenue points'),
    downloads: safeMetric(totals.downloads, 'downloads'),
    claimedOrders: safeMetric(totals.downloads, 'claimed orders'),
    fileDownloads: safeMetric(totals.file_downloads, 'file downloads'),
    fileDownloadsSince: snapshot.since.toISOString(),
    // Listing-page impressions are not recorded by the current data model.
    // Returning null keeps that absence explicit instead of inventing a count.
    views: null,
    items: snapshot.items.map((item) => ({
      id: item.id,
      title: item.title,
      sales: safeMetric(item.sales, 'sales'),
      revenuePoints: safeMetric(item.revenue_points, 'revenue points'),
      downloads: safeMetric(item.downloads, 'downloads'),
      claimedOrders: safeMetric(item.downloads, 'claimed orders'),
      fileDownloads: safeMetric(item.file_downloads, 'file downloads'),
    })),
  }, 200, {
    timezone: 'UTC',
    from: range.from,
    to: range.to,
    asOf: snapshot.asOf.toISOString(),
    metricDefinitions: {
      sales: 'Non-refunded items sold in the selected period.',
      revenuePoints: 'Creator or trainer share from non-reversed earnings allocations, including pending settlement.',
      downloads: 'Sold items with a server-recorded first content access or course-file download.',
      claimedOrders: 'Eligible items from orders paid in the selected period that claimed a file link.',
      fileDownloads: 'Complete file transfers for orders paid in the selected period, counted from the tracking start date.',
    },
    availability: {
      views: {
        available: false,
        reason: 'Listing-page impressions are not recorded by the current data model.',
      },
    },
  });
}

