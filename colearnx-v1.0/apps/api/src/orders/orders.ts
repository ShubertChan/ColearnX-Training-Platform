import type { Request, Response } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { Actor } from '../auth/auth.js';
import { query, withTransaction } from '../db/database.js';
import { sha256 } from '../lib/crypto.js';
import { ApiError, ok } from '../lib/http.js';
import { idempotencyKey, parse, uuid } from '../lib/validation.js';

const checkoutSchema = z.object({ items: z.array(z.object({ kind: z.enum(['course', 'content']), id: uuid })).min(1).max(20) }).refine((data) => new Set(data.items.map((item) => `${item.kind}:${item.id}`)).size === data.items.length, 'Items must be unique.');

type Product = { kind: 'course' | 'content'; id: string; owner_id: string; title: string; price_points: string; delivery_modes: string[]; starts_at: Date | null; capacity: number | null };

function policySnapshot(modes: string[]) {
  if (modes.includes('local')) return { rule: 'local-v1', refundable: false };
  if (modes.includes('live')) return { rule: 'live-72h', refundDeadlineHoursBeforeStart: 72 };
  return { rule: 'hosted-72h-progress-10', refundWindowHours: 72, maxProgressPercent: 10 };
}

async function claim(client: PoolClient, actorId: string, key: string, fingerprint: string) {
  const existing = await client.query<{ request_fingerprint: string; response_body: unknown }>(`SELECT request_fingerprint, response_body FROM idempotency_records WHERE actor_id = $1 AND scope = 'checkout' AND idempotency_key = $2 FOR UPDATE`, [actorId, key]);
  if (existing.rowCount) {
    if (existing.rows[0].request_fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was used for a different request.');
    if (existing.rows[0].response_body) return existing.rows[0].response_body;
    throw new ApiError(409, 'REQUEST_IN_PROGRESS', 'The matching checkout is still processing.');
  }
  await client.query(`INSERT INTO idempotency_records (actor_id, scope, idempotency_key, request_fingerprint) VALUES ($1, 'checkout', $2, $3)`, [actorId, key, fingerprint]);
  return null;
}

async function lockProduct(client: PoolClient, item: { kind: 'course' | 'content'; id: string }): Promise<Product> {
  if (item.kind === 'course') {
    const row = await client.query<Product>(`SELECT id, owner_id, title, price_points, starts_at, capacity FROM courses WHERE id = $1 AND status = 'published' FOR UPDATE`, [item.id]);
    if (!row.rowCount) throw new ApiError(404, 'COURSE_NOT_AVAILABLE', 'One or more courses are not available.');
    const modes = await client.query<{ mode: string }>('SELECT mode FROM course_delivery_modes WHERE course_id = $1 ORDER BY mode', [item.id]);
    return { ...row.rows[0], kind: 'course', delivery_modes: modes.rows.map((mode) => mode.mode) };
  }
  const row = await client.query<Product>(`SELECT id, owner_id, title, price_points, NULL::timestamptz AS starts_at, NULL::integer AS capacity, ARRAY[]::text[] AS delivery_modes FROM content_items WHERE id = $1 AND status = 'published' FOR UPDATE`, [item.id]);
  if (!row.rowCount) throw new ApiError(404, 'CONTENT_NOT_AVAILABLE', 'One or more content items are not available.');
  return { ...row.rows[0], kind: 'content' };
}

export async function checkout(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(checkoutSchema, req.body);
  const key = parse(idempotencyKey, req.get('idempotency-key'));
  const fingerprint = sha256(JSON.stringify(input));
  const response = await withTransaction(async (client) => {
    const prior = await claim(client, actor.id, key, fingerprint);
    if (prior) return prior;
    const wallet = await client.query<{ id: string; available_points: string; frozen_points: string }>('SELECT id, available_points, frozen_points FROM wallets WHERE user_id = $1 FOR UPDATE', [actor.id]);
    if (!wallet.rowCount) throw new ApiError(409, 'WALLET_NOT_FOUND', 'Your wallet is unavailable.');
    const products: Product[] = [];
    for (const item of [...input.items].sort((a, b) => a.id.localeCompare(b.id))) products.push(await lockProduct(client, item));
    for (const product of products) {
      if (product.owner_id === actor.id) throw new ApiError(403, 'OWN_PRODUCT_PURCHASE_FORBIDDEN', 'You cannot purchase your own product.');
      if (product.kind === 'course') {
        const enrolment = await client.query<{ count: string }>(`SELECT count(*) FROM enrolments WHERE course_id = $1 AND status IN ('active', 'confirmed', 'in_progress')`, [product.id]);
        if (product.capacity !== null && Number(enrolment.rows[0].count) >= product.capacity) throw new ApiError(409, 'COURSE_FULL', 'One or more courses are full.');
      }
    }
    const total = products.reduce((sum, product) => sum + Number(product.price_points), 0);
    if (Number(wallet.rows[0].available_points) < total) throw new ApiError(409, 'INSUFFICIENT_POINTS', 'You do not have enough available points.');
    const order = await client.query<{ id: string }>(`INSERT INTO orders (buyer_id, wallet_id, total_points, receipt_snapshot) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`, [actor.id, wallet.rows[0].id, total, JSON.stringify({ purchasedAt: new Date().toISOString(), testMode: true })]);
    let liveTotal = 0;
    const orderedItems: Array<{ id: string; product: Product }> = [];
    for (const product of products) {
      const modeSnapshot = product.kind === 'course' ? product.delivery_modes : [];
      const item = await client.query<{ id: string }>(`INSERT INTO order_items (order_id, product_kind, course_id, content_item_id, seller_id, title_snapshot, price_points, delivery_modes_snapshot, refund_policy_snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb) RETURNING id`, [order.rows[0].id, product.kind, product.kind === 'course' ? product.id : null, product.kind === 'content' ? product.id : null, product.owner_id, product.title, product.price_points, JSON.stringify(modeSnapshot), JSON.stringify(policySnapshot(modeSnapshot))]);
      orderedItems.push({ id: item.rows[0].id, product });
      if (modeSnapshot.includes('live')) liveTotal += Number(product.price_points);
      await client.query(`INSERT INTO earnings_allocations (order_item_id, recipient_id, share_bps, points_amount) VALUES ($1, $2, 10000, $3)`, [item.rows[0].id, product.owner_id, product.price_points]);
      if (product.kind === 'course') await client.query(`INSERT INTO enrolments (course_id, member_id, order_item_id) VALUES ($1, $2, $3)`, [product.id, actor.id, item.rows[0].id]);
      else await client.query(`INSERT INTO access_grants (content_item_id, user_id, order_item_id) VALUES ($1, $2, $3)`, [product.id, actor.id, item.rows[0].id]);
    }
    const ledger = await client.query<{ id: string }>(`INSERT INTO ledger_transactions (wallet_id, type, business_reference, metadata) VALUES ($1, $2, $3, jsonb_build_object('orderId', $4)) RETURNING id`, [wallet.rows[0].id, liveTotal ? 'live_reserve' : 'purchase', `order:${order.rows[0].id}`, order.rows[0].id]);
    const entries: Array<[string, string | null, string, number]> = [[ledger.rows[0].id, wallet.rows[0].id, 'user_available', -total]];
    if (liveTotal) entries.push([ledger.rows[0].id, wallet.rows[0].id, 'user_frozen', liveTotal]);
    if (total - liveTotal) entries.push([ledger.rows[0].id, null, 'system_settlement', total - liveTotal]);
    for (const [transactionId, walletId, accountCode, delta] of entries) await client.query(`INSERT INTO ledger_entries (ledger_transaction_id, wallet_id, account_code, points_delta) VALUES ($1, $2, $3, $4)`, [transactionId, walletId, accountCode, delta]);
    await client.query(`UPDATE wallets SET available_points = available_points - $2, frozen_points = frozen_points + $3, updated_at = now() WHERE id = $1`, [wallet.rows[0].id, total, liveTotal]);
    await client.query(`INSERT INTO audit_logs (actor_id, action, target_type, target_id, outcome, request_id) VALUES ($1, 'checkout.complete', 'order', $2, 'success', $3)`, [actor.id, order.rows[0].id, res.locals.requestId]);
    await client.query(`INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload) VALUES ('order', $1, 'order.paid', jsonb_build_object('orderId', $1))`, [order.rows[0].id]);
    const body = { id: order.rows[0].id, status: 'paid', totalPoints: total, remainingAvailablePoints: Number(wallet.rows[0].available_points) - total, items: orderedItems.map(({ id, product }) => ({ id, kind: product.kind, productId: product.id, title: product.title, pricePoints: Number(product.price_points) })) };
    await client.query(`UPDATE idempotency_records SET response_status = 201, response_body = $4::jsonb, completed_at = now() WHERE actor_id = $1 AND scope = 'checkout' AND idempotency_key = $2 AND request_fingerprint = $3`, [actor.id, key, fingerprint, JSON.stringify(body)]);
    return body;
  });
  return ok(res, response, 201);
}

export async function listOrders(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const result = await query(`SELECT id, status, total_points, created_at FROM orders WHERE buyer_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`, [actor.id]);
  return ok(res, result.rows.map((row) => ({ id: row.id, status: row.status, totalPoints: Number(row.total_points), createdAt: row.created_at })));
}

export async function getOrder(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const id = parse(uuid, req.params.id);
  const order = await query(`SELECT id, status, total_points, receipt_snapshot, created_at FROM orders WHERE id = $1 AND buyer_id = $2`, [id, actor.id]);
  if (!order.rowCount) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order was not found.');
  const items = await query(`SELECT id, product_kind, course_id, content_item_id, title_snapshot, price_points, delivery_modes_snapshot, refund_policy_snapshot FROM order_items WHERE order_id = $1`, [id]);
  return ok(res, { id: order.rows[0].id, status: order.rows[0].status, totalPoints: Number(order.rows[0].total_points), receipt: order.rows[0].receipt_snapshot, createdAt: order.rows[0].created_at, items: items.rows.map((item) => ({ id: item.id, kind: item.product_kind, productId: item.course_id ?? item.content_item_id, title: item.title_snapshot, pricePoints: Number(item.price_points), deliveryModes: item.delivery_modes_snapshot, refundPolicy: item.refund_policy_snapshot })) });
}
