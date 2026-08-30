import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { query, withTransaction } from '../db/database.js';
import { sha256 } from '../lib/crypto.js';
import { ApiError, ok } from '../lib/http.js';
import { idempotencyKey, parse, uuid } from '../lib/validation.js';
import { loadSystemPointAccount, postPointTransaction } from '../points/ledger.js';

const checkoutSchema = z.object({
  items: z.array(z.object({ kind: z.enum(['course', 'content']), id: uuid })).min(1).max(20),
}).refine((data) => new Set(data.items.map((item) => `${item.kind}:${item.id}`)).size === data.items.length, 'Items must be unique.');

const orderListQuery = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

type Product = {
  kind: 'course' | 'content';
  id: string;
  sellerUserId: string;
  title: string;
  pricePoints: number;
  deliveryModes: string[];
  startsAt: Date | null;
  capacity: number | null;
  refundPolicyId: string | null;
};

type RevenuePolicy = {
  revenue_share_policy_id: string;
  policy_code: string;
  platform_share_bps: number;
  trainer_share_bps: number;
  creator_share_bps: number;
};

function points(value: string, field: string) {
  const valueAsNumber = Number(value);
  if (!Number.isSafeInteger(valueAsNumber) || valueAsNumber < 0) {
    throw new ApiError(409, 'INVALID_PRICE', `${field} is not a supported points amount.`);
  }
  return valueAsNumber;
}

function refundPolicySnapshot(product: Product, purchasedAt: Date) {
  if (product.deliveryModes.includes('local')) return { rule: 'local-v1', refundable: false };
  if (product.deliveryModes.includes('live')) {
    return { rule: 'live-72h', refundDeadlineHoursBeforeStart: 72, startsAt: product.startsAt?.toISOString() ?? null };
  }
  if (product.deliveryModes.includes('cloud') || product.deliveryModes.includes('record')) {
    return { rule: 'hosted-72h-progress-10', refundWindowHours: 72, maxProgressPercent: 10, purchasedAt: purchasedAt.toISOString() };
  }
  return { rule: 'content-policy-required', refundable: false };
}

function refundDeadline(product: Product, purchasedAt: Date) {
  if (product.deliveryModes.includes('live') && product.startsAt) return new Date(product.startsAt.getTime() - 72 * 60 * 60 * 1000);
  if (product.deliveryModes.includes('cloud') || product.deliveryModes.includes('record')) return new Date(purchasedAt.getTime() + 72 * 60 * 60 * 1000);
  return null;
}

async function claimIdempotency(client: PoolClient, actorId: string, key: string, fingerprint: string) {
  const existing = await client.query<{ request_fingerprint: string; response_body: CheckoutResponse | null }>(`SELECT request_fingerprint, response_body
    FROM idempotency_records
    WHERE actor_user_id = $1 AND operation_scope = 'checkout' AND idempotency_key = $2
    FOR UPDATE`, [actorId, key]);
  if (existing.rowCount) {
    if (existing.rows[0].request_fingerprint !== fingerprint) {
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different checkout.');
    }
    if (existing.rows[0].response_body) return existing.rows[0].response_body;
    throw new ApiError(409, 'REQUEST_IN_PROGRESS', 'The matching checkout is still processing.');
  }
  await client.query(`INSERT INTO idempotency_records (actor_user_id, operation_scope, idempotency_key, request_fingerprint)
    VALUES ($1, 'checkout', $2, $3)`, [actorId, key, fingerprint]);
  return null;
}

async function lockProduct(client: PoolClient, item: { kind: 'course' | 'content'; id: string }): Promise<Product> {
  if (item.kind === 'course') {
    const course = await client.query<{
      course_run_id: string;
      owner_user_id: string;
      title: string;
      price_points: string;
      starts_at: Date | null;
      capacity: number | null;
      refund_policy_id: string | null;
    }>(`SELECT cr.course_run_id, c.owner_user_id, c.title, cr.price_points, cr.starts_at, cr.capacity, cr.refund_policy_id
      FROM course_runs cr JOIN courses c ON c.course_id = cr.course_id
      WHERE cr.course_run_id = $1 AND cr.run_status = 'published' AND c.publication_status = 'published'
      FOR UPDATE OF cr, c`, [item.id]);
    if (!course.rowCount) throw new ApiError(404, 'COURSE_NOT_AVAILABLE', 'One or more courses are not available.');
    const delivery = await client.query<{ delivery_type: string }>(`SELECT delivery_type FROM course_delivery_options
      WHERE course_run_id = $1 AND option_status = 'active' ORDER BY delivery_type`, [item.id]);
    const deliveryModes = delivery.rows.map((row) => row.delivery_type);
    if (!deliveryModes.length) throw new ApiError(409, 'COURSE_DELIVERY_UNAVAILABLE', 'This course has no active delivery option.');
    if (deliveryModes.length === 1 && deliveryModes[0] === 'record') {
      throw new ApiError(409, 'RECORD_SALE_DISABLED', 'Independent Record replay sale is not enabled.');
    }
    const row = course.rows[0];
    return {
      kind: 'course', id: row.course_run_id, sellerUserId: row.owner_user_id, title: row.title,
      pricePoints: points(row.price_points, 'Course price'), deliveryModes, startsAt: row.starts_at,
      capacity: row.capacity, refundPolicyId: row.refund_policy_id,
    };
  }

  const content = await client.query<{
    content_version_id: string;
    creator_user_id: string;
    title: string;
    price_points: string;
    refund_policy_id: string | null;
  }>(`SELECT cv.content_version_id, c.creator_user_id, c.title, c.price_points, c.refund_policy_id
    FROM content_versions cv JOIN contents c ON c.content_id = cv.content_id
    WHERE cv.content_version_id = $1 AND cv.version_status = 'published' AND c.publication_status = 'published'
    FOR UPDATE OF cv, c`, [item.id]);
  if (!content.rowCount) throw new ApiError(404, 'CONTENT_NOT_AVAILABLE', 'One or more content items are not available.');
  const row = content.rows[0];
  return {
    kind: 'content', id: row.content_version_id, sellerUserId: row.creator_user_id, title: row.title,
    pricePoints: points(row.price_points, 'Content price'), deliveryModes: [], startsAt: null,
    capacity: null, refundPolicyId: row.refund_policy_id,
  };
}

async function assertPurchasable(client: PoolClient, product: Product, actorId: string) {
  if (product.sellerUserId === actorId) {
    throw new ApiError(403, 'OWN_PRODUCT_PURCHASE_FORBIDDEN', 'You cannot purchase your own product.');
  }
  if (product.kind === 'course') {
    const enrolment = await client.query<{ count: string }>(`SELECT count(*) FROM course_enrolments
      WHERE course_run_id = $1 AND learner_user_id = $2 AND enrolment_status IN ('active', 'confirmed', 'in_progress')`, [product.id, actorId]);
    if (Number(enrolment.rows[0].count) > 0) throw new ApiError(409, 'ALREADY_ENROLLED', 'You are already enrolled in this course.');
    const totalEnrolments = await client.query<{ count: string }>(`SELECT count(*) FROM course_enrolments
      WHERE course_run_id = $1 AND enrolment_status IN ('active', 'confirmed', 'in_progress')`, [product.id]);
    if (product.capacity !== null && Number(totalEnrolments.rows[0].count) >= product.capacity) {
      throw new ApiError(409, 'COURSE_FULL', 'One or more courses are full.');
    }
    return;
  }
  const grant = await client.query(`SELECT 1 FROM content_access_grants WHERE content_version_id = $1 AND user_id = $2`, [product.id, actorId]);
  if (grant.rowCount) throw new ApiError(409, 'ALREADY_PURCHASED', 'You already own this content version.');
}

async function loadRevenuePolicy(client: PoolClient, product: Product): Promise<RevenuePolicy> {
  const productKind = product.kind === 'course' ? 'course_run' : 'content_version';
  const policy = await client.query<RevenuePolicy>(`SELECT revenue_share_policy_id, policy_code,
      platform_share_bps, trainer_share_bps, creator_share_bps
    FROM revenue_share_policies
    WHERE product_kind = $1 AND is_active = true AND retired_at IS NULL
    FOR SHARE`, [productKind]);
  if (!policy.rowCount) {
    throw new ApiError(503, 'REVENUE_SHARE_POLICY_NOT_CONFIGURED', 'Checkout is unavailable until the revenue-share policy is approved.');
  }
  return policy.rows[0];
}

async function createAllocations(client: PoolClient, orderItemId: string, product: Product, policy: RevenuePolicy) {
  const sellerShare = product.kind === 'course' ? policy.trainer_share_bps : policy.creator_share_bps;
  const sellerKind = product.kind === 'course' ? 'trainer' : 'creator';
  const productTotal = product.pricePoints;
  const platformPoints = Math.floor(productTotal * policy.platform_share_bps / 10000);
  const sellerPoints = productTotal - platformPoints;
  const values: Array<[string, string, string | null, number, number]> = [
    [orderItemId, 'platform', null, policy.platform_share_bps, platformPoints],
    [orderItemId, sellerKind, product.sellerUserId, sellerShare, sellerPoints],
  ];
  for (const [itemId, kind, recipientId, shareBps, allocationPoints] of values) {
    await client.query(`INSERT INTO earnings_allocations
      (order_item_id, recipient_kind, recipient_user_id, share_bps, points_amount)
      VALUES ($1, $2, $3, $4, $5)`, [itemId, kind, recipientId, shareBps, allocationPoints]);
  }
}

type CheckoutResponse = {
  id: string;
  orderNo: string;
  status: 'paid';
  totalPoints: number;
  remainingAvailablePoints: number;
  items: Array<{ id: string; kind: 'course' | 'content'; productId: string; title: string; pricePoints: number }>;
};

export async function checkout(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(checkoutSchema, req.body);
  const key = parse(idempotencyKey, req.get('idempotency-key'));
  const fingerprint = sha256(JSON.stringify(input));
  const response = await withTransaction(async (client) => {
    const cached = await claimIdempotency(client, actor.id, key, fingerprint);
    if (cached) return cached;
    const products: Product[] = [];
    for (const item of [...input.items].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))) {
      products.push(await lockProduct(client, item));
    }
    for (const product of products) await assertPurchasable(client, product, actor.id);
    const revenuePolicies = await Promise.all(products.map((product) => loadRevenuePolicy(client, product)));
    const total = products.reduce((sum, product) => sum + product.pricePoints, 0);
    if (!Number.isSafeInteger(total)) throw new ApiError(409, 'INVALID_PRICE', 'Checkout total is too large.');

    const purchasedAt = new Date();
    const orderNo = `ORD-${randomUUID()}`;
    const order = await client.query<{ order_id: string }>(`INSERT INTO orders
      (buyer_user_id, order_no, total_points, paid_at, receipt_snapshot_json)
      VALUES ($1, $2, $3, now(), $4::jsonb) RETURNING order_id`, [
      actor.id, orderNo, total,
      JSON.stringify({ purchasedAt: purchasedAt.toISOString(), environment: envMode(), testMode: true }),
    ]);
    const system = await loadSystemPointAccount(client);
    const buyerPointAccountId = await userPointAccountId(client, actor.id);
    const orderedItems: CheckoutResponse['items'] = [];
    for (const [index, product] of products.entries()) {
      const revenuePolicy = revenuePolicies[index];
      const isLiveReservation = product.deliveryModes.includes('live') && !!product.startsAt && product.startsAt > purchasedAt;
      const policySnapshot = refundPolicySnapshot(product, purchasedAt);
      const orderItem = await client.query<{ order_item_id: string }>(`INSERT INTO order_items
        (order_id, item_type, course_run_id, content_version_id, seller_user_id, item_title_snapshot, points_amount,
         refund_policy_id, refund_policy_snapshot_json, refund_deadline_at, fulfilment_status,
         delivery_modes_snapshot_json, revenue_share_bps, revenue_share_snapshot_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb, 10000, $13::jsonb)
        RETURNING order_item_id`, [
        order.rows[0].order_id,
        product.kind === 'course' ? 'course_run' : 'content_version',
        product.kind === 'course' ? product.id : null,
        product.kind === 'content' ? product.id : null,
        product.sellerUserId, product.title, product.pricePoints, product.refundPolicyId,
        JSON.stringify(policySnapshot), refundDeadline(product, purchasedAt), isLiveReservation ? 'reserved' : 'fulfilled',
        JSON.stringify(product.deliveryModes), JSON.stringify({ policyCode: revenuePolicy.policy_code, platformShareBps: revenuePolicy.platform_share_bps,
          trainerShareBps: revenuePolicy.trainer_share_bps, creatorShareBps: revenuePolicy.creator_share_bps }),
      ]);
      const orderItemId = orderItem.rows[0].order_item_id;
      await createAllocations(client, orderItemId, product, revenuePolicy);
      if (product.kind === 'course') {
        await client.query(`INSERT INTO course_enrolments (course_run_id, learner_user_id, order_item_id, enrolment_status)
          VALUES ($1, $2, $3, 'confirmed')`, [product.id, actor.id, orderItemId]);
      } else {
        await client.query(`INSERT INTO content_access_grants (content_version_id, user_id, order_item_id, grant_reason)
          VALUES ($1, $2, $3, 'purchase')`, [product.id, actor.id, orderItemId]);
      }
      const transactionId = product.pricePoints > 0 ? await postPointTransaction(client, isLiveReservation ? {
        type: 'live_hold', reason: 'live_course_purchase_reserve', idempotencyKey: `order-item:${orderItemId}`,
        orderItemId,
        entries: [
          { pointAccountId: buyerPointAccountId, entryRole: 'member_available_debit', availableDelta: -product.pricePoints },
          { pointAccountId: buyerPointAccountId, entryRole: 'member_frozen_credit', frozenDelta: product.pricePoints },
        ],
      } : {
        type: 'purchase', reason: 'points_purchase', idempotencyKey: `order-item:${orderItemId}`,
        orderItemId,
        entries: [
          { pointAccountId: buyerPointAccountId, entryRole: 'member_available_debit', availableDelta: -product.pricePoints },
          { pointAccountId: system.point_account_id, entryRole: 'platform_settlement_credit', availableDelta: product.pricePoints },
        ],
      }) : null;
      if (isLiveReservation && transactionId) {
        await client.query(`INSERT INTO point_holds (purchase_transaction_id, points_amount, release_trigger)
          VALUES ($1, $2, 'course_start')`, [transactionId, product.pricePoints]);
      }
      orderedItems.push({ id: orderItemId, kind: product.kind, productId: product.id, title: product.title, pricePoints: product.pricePoints });
    }
    const pointAccount = await client.query<{ available_balance: string }>(`SELECT available_balance FROM point_accounts
      WHERE user_id = $1 AND account_status = 'active'`, [actor.id]);
    if (!pointAccount.rowCount) throw new ApiError(409, 'POINT_ACCOUNT_NOT_FOUND', 'Your point account is unavailable.');
    const body: CheckoutResponse = {
      id: order.rows[0].order_id, orderNo, status: 'paid', totalPoints: total,
      remainingAvailablePoints: Number(pointAccount.rows[0].available_balance), items: orderedItems,
    };
    await client.query(`UPDATE idempotency_records SET response_status = 201, response_body = $4::jsonb, completed_at = now()
      WHERE actor_user_id = $1 AND operation_scope = 'checkout' AND idempotency_key = $2 AND request_fingerprint = $3`,
      [actor.id, key, fingerprint, JSON.stringify(body)]);
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, 'checkout.complete', 'orders', $2, jsonb_build_object('totalPoints', $3::bigint, 'outcome', 'success'), $4)`,
      [actor.id, order.rows[0].order_id, total, res.locals.requestId]);
    await client.query(`INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
      VALUES ('order', $1, 'order.paid', jsonb_build_object('orderId', $1::uuid))`, [order.rows[0].order_id]);
    return body;
  });
  return ok(res, response, 201);
}

async function userPointAccountId(client: PoolClient, userId: string) {
  const account = await client.query<{ point_account_id: string }>(`SELECT point_account_id FROM point_accounts
    WHERE user_id = $1 AND account_status = 'active'`, [userId]);
  if (!account.rowCount) throw new ApiError(409, 'POINT_ACCOUNT_NOT_FOUND', 'Your point account is unavailable.');
  return account.rows[0].point_account_id;
}

function envMode() {
  return process.env.NODE_ENV === 'production' ? 'production' : 'test';
}

export async function listOrders(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(orderListQuery, req.query);
  const result = await query(`SELECT order_id, order_no, order_status, total_points, created_at, paid_at
    FROM orders WHERE buyer_user_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
    ORDER BY created_at DESC, order_id DESC LIMIT $3`, [actor.id, input.cursor ?? null, input.limit]);
  const items = result.rows.map((row) => ({ id: row.order_id, orderNo: row.order_no, status: row.order_status,
    totalPoints: Number(row.total_points), createdAt: row.created_at, paidAt: row.paid_at }));
  return ok(res, items, 200, { nextCursor: items.length === input.limit ? items.at(-1)?.createdAt : null });
}

export async function getOrder(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const orderId = parse(uuid, req.params.id);
  const order = await query(`SELECT order_id, order_no, order_status, total_points, receipt_snapshot_json, created_at, paid_at
    FROM orders WHERE order_id = $1 AND buyer_user_id = $2`, [orderId, actor.id]);
  if (!order.rowCount) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order was not found.');
  const itemRows = await query(`SELECT order_item_id, item_type, course_run_id, content_version_id, item_title_snapshot,
      points_amount, delivery_modes_snapshot_json, refund_policy_snapshot_json, refund_deadline_at, fulfilment_status,
      revenue_share_snapshot_json
    FROM order_items WHERE order_id = $1 ORDER BY order_item_id`, [orderId]);
  const row = order.rows[0];
  return ok(res, {
    id: row.order_id, orderNo: row.order_no, status: row.order_status, totalPoints: Number(row.total_points),
    receipt: row.receipt_snapshot_json, createdAt: row.created_at, paidAt: row.paid_at,
    items: itemRows.rows.map((item) => ({ id: item.order_item_id, kind: item.item_type === 'course_run' ? 'course' : 'content',
      productId: item.course_run_id ?? item.content_version_id, title: item.item_title_snapshot, pricePoints: Number(item.points_amount),
      deliveryModes: item.delivery_modes_snapshot_json, refundPolicy: item.refund_policy_snapshot_json,
      refundDeadlineAt: item.refund_deadline_at, fulfilmentStatus: item.fulfilment_status,
      revenueShare: item.revenue_share_snapshot_json })),
  });
}
