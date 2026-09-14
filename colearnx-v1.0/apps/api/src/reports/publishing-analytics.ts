import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { ok } from '../lib/http.js';
import { resolveUtcDateRange } from '../lib/reporting-dates.js';
import { optionalReportingDate, safeMetric, withReadOnlySnapshot } from '../lib/reporting-query.js';
import { parse } from '../lib/validation.js';

const publishingAnalyticsInput = z.object({
  kind: z.enum(['course', 'content']),
  from: optionalReportingDate,
  to: optionalReportingDate,
}).strict();

type TotalRow = { sales: string; revenue_points: string; downloads: string };
type ItemRow = { id: string; title: string; sales: string; revenue_points: string; downloads: string };

function metricsQuery(groupBy = false) {
  return `WITH owned_items AS (
    SELECT oi.order_item_id,
      COALESCE(oi.course_run_id, oi.content_version_id)::text AS id,
      oi.item_title_snapshot AS title,
      COALESCE(earnings.points_amount, 0)::text AS revenue_points,
      CASE
        WHEN oi.item_type = 'course_run' THEN EXISTS (
          SELECT 1
            FROM course_enrolments ce
            JOIN course_access_progress cap ON cap.enrolment_id = ce.enrolment_id
           WHERE ce.order_item_id = oi.order_item_id
             AND cap.download_completed_at IS NOT NULL
        )
        ELSE EXISTS (
          SELECT 1
            FROM content_access_grants cag
           WHERE cag.order_item_id = oi.order_item_id
             AND cag.first_accessed_at IS NOT NULL
        )
      END AS downloaded
    FROM order_items oi
    JOIN orders o ON o.order_id = oi.order_id
    LEFT JOIN earnings_allocations earnings
      ON earnings.order_item_id = oi.order_item_id
     AND earnings.recipient_user_id = $1
     AND earnings.allocation_status <> 'reversed'
    WHERE oi.seller_user_id = $1
      AND oi.item_type = $2
      AND oi.fulfilment_status NOT IN ('refunded', 'cancelled')
      AND o.paid_at IS NOT NULL
      AND o.paid_at >= ($3::date::timestamp AT TIME ZONE 'UTC')
      AND o.paid_at < (($4::date + 1)::timestamp AT TIME ZONE 'UTC')
  )
  SELECT ${groupBy ? 'id, title,' : ''}
    count(*)::text AS sales,
    COALESCE(sum(revenue_points::bigint), 0)::text AS revenue_points,
    count(*) FILTER (WHERE downloaded)::text AS downloads
  FROM owned_items
  ${groupBy ? 'GROUP BY id, title ORDER BY count(*) DESC, sum(revenue_points::bigint) DESC, title ASC LIMIT 100' : ''}`;
}

export async function publishingAnalytics(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(publishingAnalyticsInput, req.query);
  const range = resolveUtcDateRange(input);
  const itemType = input.kind === 'course' ? 'course_run' : 'content_version';
  const snapshot = await withReadOnlySnapshot(async (client) => {
    const [asOfResult, totals, items] = await Promise.all([
      client.query<{ as_of: Date }>('SELECT now() AS as_of'),
      client.query<TotalRow>(metricsQuery(), [actor.id, itemType, range.from, range.to]),
      client.query<ItemRow>(metricsQuery(true), [actor.id, itemType, range.from, range.to]),
    ]);
    return { asOf: asOfResult.rows[0].as_of, totals: totals.rows[0], items: items.rows };
  });

  const totals = snapshot.totals ?? { sales: '0', revenue_points: '0', downloads: '0' };
  return ok(res, {
    sales: safeMetric(totals.sales, 'sales'),
    revenuePoints: safeMetric(totals.revenue_points, 'revenue points'),
    downloads: safeMetric(totals.downloads, 'downloads'),
    // Listing-page impressions are not recorded by the current data model.
    // Returning null keeps that absence explicit instead of inventing a count.
    views: null,
    items: snapshot.items.map((item) => ({
      id: item.id,
      title: item.title,
      sales: safeMetric(item.sales, 'sales'),
      revenuePoints: safeMetric(item.revenue_points, 'revenue points'),
      downloads: safeMetric(item.downloads, 'downloads'),
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
    },
    availability: {
      views: {
        available: false,
        reason: 'Listing-page impressions are not recorded by the current data model.',
      },
    },
  });
}

