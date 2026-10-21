import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { query } from '../db/database.js';
import { ApiError, ok } from '../lib/http.js';
import { parse, uuid } from '../lib/validation.js';
import { refundNotificationChannel, refundNotificationEvents } from './notification-events.js';

export async function recordRefundNotification(client: PoolClient, input: {
  refundRequestId: string; userId: string; title: string; reason: string;
}) {
  const inserted = await client.query(`INSERT INTO notifications
    (user_id, notification_type, title, message, refund_request_id)
    VALUES ($1, 'refund_decision', $2, $3, $4)
    ON CONFLICT (refund_request_id) DO NOTHING RETURNING notification_id`,
  [input.userId, input.title, input.reason, input.refundRequestId]);
  if (inserted.rowCount) {
    // Only an opaque owner ID is broadcast. Details stay behind authenticated reads.
    await client.query('SELECT pg_notify($1, $2)', [refundNotificationChannel, input.userId]);
  }
}

async function unreadRefunds(userId: string) {
  const result = await query(`SELECT n.notification_id, n.title, n.message, n.created_at,
    rr.refund_request_id, rr.refund_status, rr.requested_points, oi.order_id
    FROM notifications n
    JOIN refund_requests rr ON rr.refund_request_id = n.refund_request_id
    JOIN order_items oi ON oi.order_item_id = rr.order_item_id
    WHERE n.user_id = $1 AND rr.requested_by_user_id = $1
      AND n.notification_type = 'refund_decision' AND n.is_read = false
    ORDER BY n.created_at ASC, n.notification_id ASC LIMIT 20`, [userId]);
  return result.rows.map(row => ({
    id: row.notification_id, refundRequestId: row.refund_request_id, status: row.refund_status,
    itemTitle: row.title, decisionReason: row.message, points: Number(row.requested_points),
    orderId: row.order_id, createdAt: row.created_at,
  }));
}

export async function listRefundNotifications(req: Request, res: Response) {
  const { wait } = parse(z.object({ wait: z.enum(['1']).optional() }), req.query);
  const actor = res.locals.actor as Actor;
  if (!wait) return ok(res, await unreadRefunds(actor.id));

  let wake!: () => void;
  const changed = new Promise<void>(resolve => { wake = resolve; });
  // Subscribe before reading so a commit between the read and wait isn't lost.
  const subscription = refundNotificationEvents.subscribe(actor.id, wake);
  let timer: ReturnType<typeof setTimeout> | undefined;
  res.once('close', wake);
  try {
    const listening = await subscription.ready;
    if (res.destroyed) return;
    let messages = await unreadRefunds(actor.id);
    if (!messages.length) {
      // If LISTEN is unavailable (e.g. a transaction-pooling proxy), durable
      // reads still deliver results with a one-second fallback.
      await Promise.race([listening ? changed : new Promise<void>(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, listening ? 20000 : 1000); })]);
      if (res.destroyed) return;
      messages = await unreadRefunds(actor.id);
    }
    return ok(res, messages);
  } finally {
    clearTimeout(timer);
    subscription.dispose();
    res.off('close', wake);
  }
}

export async function acknowledgeRefundNotification(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const id = parse(uuid, req.params.id);
  const result = await query(`UPDATE notifications SET is_read = true, read_at = COALESCE(read_at, now())
    WHERE notification_id = $1 AND user_id = $2 AND notification_type = 'refund_decision'
    RETURNING notification_id`, [id, actor.id]);
  if (!result.rowCount) throw new ApiError(404, 'NOTIFICATION_NOT_FOUND', 'Notification was not found.');
  return ok(res, { id, read: true });
}
