import type { Request, Response } from 'express';
import { z } from 'zod';
import { ok } from '../lib/http.js';
import { resolveUtcDateRange, utcDates } from '../lib/reporting-dates.js';
import { optionalReportingDate, safeMetric, withReadOnlySnapshot } from '../lib/reporting-query.js';
import { parse } from '../lib/validation.js';

const activityInput = z.object({ from: optionalReportingDate, to: optionalReportingDate }).strict();

type DayCount = { date: string; total: string };
type Total = { total: string };

export async function activityReport(req: Request, res: Response) {
  const input = parse(activityInput, req.query);
  const range = resolveUtcDateRange(input);
  const snapshot = await withReadOnlySnapshot(async (client) => {
    const [asOfResult, orderRows, reportRows, revenueResult] = await Promise.all([
      client.query<{ as_of: Date }>('SELECT now() AS as_of'),
      client.query<DayCount>(
        `SELECT (created_at AT TIME ZONE 'UTC')::date::text AS date, count(*)::text AS total
           FROM orders
          WHERE created_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
            AND created_at < (($2::date + 1)::timestamp AT TIME ZONE 'UTC')
          GROUP BY 1`,
        [range.from, range.to],
      ),
      client.query<DayCount>(
        `SELECT (created_at AT TIME ZONE 'UTC')::date::text AS date, count(*)::text AS total
           FROM user_reports
          WHERE created_at IS NOT NULL
            AND created_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
            AND created_at < (($2::date + 1)::timestamp AT TIME ZONE 'UTC')
          GROUP BY 1`,
        [range.from, range.to],
      ),
      client.query<Total>(
        `SELECT COALESCE(sum(total_points), 0)::text AS total
           FROM orders
          WHERE paid_at IS NOT NULL
            AND paid_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
            AND paid_at < (($2::date + 1)::timestamp AT TIME ZONE 'UTC')`,
        [range.from, range.to],
      ),
    ]);
    return { asOf: asOfResult.rows[0].as_of, orderRows: orderRows.rows, reportRows: reportRows.rows, revenue: revenueResult.rows[0]?.total ?? '0' };
  });

  const ordersByDate = new Map(snapshot.orderRows.map((row) => [row.date, safeMetric(row.total, 'orders')]));
  const reportsByDate = new Map(snapshot.reportRows.map((row) => [row.date, safeMetric(row.total, 'reports')]));
  const items = utcDates(range).map((date) => ({
    date,
    activeUsers: null,
    orders: ordersByDate.get(date) ?? 0,
    reports: reportsByDate.get(date) ?? 0,
  }));
  return ok(res, {
    activeUsers: null,
    orders: items.reduce((total, item) => total + item.orders, 0),
    reports: items.reduce((total, item) => total + item.reports, 0),
    revenuePoints: safeMetric(snapshot.revenue, 'revenue points'),
    items,
  }, 200, {
    timezone: 'UTC',
    from: range.from,
    to: range.to,
    asOf: snapshot.asOf.toISOString(),
    metricDefinitions: {
      orders: 'Orders created in the selected period.',
      reports: 'Reports created in the selected period with a known creation time.',
      revenuePoints: 'Gross points on orders paid in the selected period; refunds are not deducted.',
    },
    availability: {
      activeUsers: {
        available: false,
        reason: 'Reliable activity coverage is not established for this period.',
      },
    },
  });
}
