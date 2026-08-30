import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { query, withTransaction } from '../db/database.js';
import { ApiError, ok } from '../lib/http.js';
import { parse, uuid } from '../lib/validation.js';
import { evaluateRefund } from './policy.js';

const requestSchema = z.object({ orderItemId: uuid, reason: z.string().trim().min(5).max(2000) });
const decisionSchema = z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string().trim().min(3).max(2000) });

function decisionFromRow(row: Record<string, unknown>) {
  const modes = Array.isArray(row.delivery_modes_snapshot) ? row.delivery_modes_snapshot as string[] : [];
  return evaluateRefund({ deliveryModes: modes, purchasedAt: new Date(row.purchased_at as string), requestTime: new Date(), progressPercent: Number(row.progress_percent ?? 0), startsAt: row.starts_at ? new Date(row.starts_at as string) : null });
}

export async function createRefundRequest(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(requestSchema, req.body);
  const response = await withTransaction(async (client) => {
    const item = await client.query(`SELECT oi.id, oi.order_id, oi.product_kind, oi.price_points, oi.delivery_modes_snapshot, o.created_at AS purchased_at, c.starts_at, e.progress_percent
      FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN courses c ON c.id = oi.course_id LEFT JOIN enrolments e ON e.order_item_id = oi.id
      WHERE oi.id = $1 AND o.buyer_id = $2 FOR UPDATE`, [input.orderItemId, actor.id]);
    if (!item.rowCount) throw new ApiError(404, 'ORDER_ITEM_NOT_FOUND', 'This purchased item was not found.');
    if (item.rows[0].product_kind !== 'course') throw new ApiError(409, 'REFUND_NOT_AVAILABLE', 'This item has no approved refund policy.');
    const eligibility = decisionFromRow(item.rows[0]);
    if (!eligibility.eligible) throw new ApiError(409, 'REFUND_NOT_ELIGIBLE', eligibility.explanation, { policyCode: eligibility.code });
    const created = await client.query(`INSERT INTO refund_requests (order_item_id, requester_id, reason, eligibility_snapshot) VALUES ($1, $2, $3, $4::jsonb) RETURNING id, status, requested_at`, [input.orderItemId, actor.id, input.reason, JSON.stringify(eligibility)]);
    await client.query(`INSERT INTO audit_logs (actor_id, action, target_type, target_id, outcome, request_id) VALUES ($1, 'refund.request', 'refund_request', $2, 'success', $3)`, [actor.id, created.rows[0].id, res.locals.requestId]);
    return created.rows[0];
  });
  return ok(res, { id: response.id, status: response.status, requestedAt: response.requested_at }, 201);
}

export async function getRefundRequest(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const id = parse(uuid, req.params.id);
  const result = await query(`SELECT rr.id, rr.status, rr.reason, rr.eligibility_snapshot, rr.requested_at, rr.decided_at, rr.decision_reason FROM refund_requests rr WHERE rr.id = $1 AND rr.requester_id = $2`, [id, actor.id]);
  if (!result.rowCount) throw new ApiError(404, 'REFUND_REQUEST_NOT_FOUND', 'Refund request was not found.');
  const row = result.rows[0];
  return ok(res, { id: row.id, status: row.status, reason: row.reason, eligibility: row.eligibility_snapshot, requestedAt: row.requested_at, decidedAt: row.decided_at, decisionReason: row.decision_reason });
}

export async function decideRefund(req: Request, res: Response) {
  const admin = res.locals.actor as Actor;
  const id = parse(uuid, req.params.id);
  const input = parse(decisionSchema, req.body);
  const response = await withTransaction(async (client) => {
    const request = await client.query(`SELECT rr.id, rr.status, rr.order_item_id, rr.requester_id, oi.price_points, oi.delivery_modes_snapshot, oi.order_id, o.created_at AS purchased_at, c.starts_at, e.progress_percent, w.id AS wallet_id
      FROM refund_requests rr JOIN order_items oi ON oi.id = rr.order_item_id JOIN orders o ON o.id = oi.order_id LEFT JOIN courses c ON c.id = oi.course_id LEFT JOIN enrolments e ON e.order_item_id = oi.id JOIN wallets w ON w.user_id = rr.requester_id
      WHERE rr.id = $1 FOR UPDATE`, [id]);
    if (!request.rowCount) throw new ApiError(404, 'REFUND_REQUEST_NOT_FOUND', 'Refund request was not found.');
    const row = request.rows[0];
    if (row.status !== 'pending') throw new ApiError(409, 'REFUND_ALREADY_DECIDED', 'This refund request has already been decided.');
    const currentEligibility = decisionFromRow(row);
    if (input.decision === 'approved' && !currentEligibility.eligible) throw new ApiError(409, 'REFUND_NO_LONGER_ELIGIBLE', currentEligibility.explanation, { policyCode: currentEligibility.code });
    await client.query(`UPDATE refund_requests SET status = $2, decided_by = $3, decision_reason = $4, decided_at = now() WHERE id = $1`, [id, input.decision, admin.id, input.reason]);
    if (input.decision === 'approved') {
      const modes = Array.isArray(row.delivery_modes_snapshot) ? row.delivery_modes_snapshot as string[] : [];
      const frozen = modes.includes('live') ? Number(row.price_points) : 0;
      const ledger = await client.query<{ id: string }>(`INSERT INTO ledger_transactions (wallet_id, type, business_reference, metadata) VALUES ($1, 'refund', $2, jsonb_build_object('refundRequestId', $3)) RETURNING id`, [row.wallet_id, `refund:${id}`, id]);
      await client.query(`INSERT INTO ledger_entries (ledger_transaction_id, wallet_id, account_code, points_delta) VALUES ($1, $2, 'user_available', $3)`, [ledger.rows[0].id, row.wallet_id, row.price_points]);
      if (frozen) await client.query(`INSERT INTO ledger_entries (ledger_transaction_id, wallet_id, account_code, points_delta) VALUES ($1, $2, 'user_frozen', $3)`, [ledger.rows[0].id, row.wallet_id, -frozen]);
      if (Number(row.price_points) - frozen) await client.query(`INSERT INTO ledger_entries (ledger_transaction_id, wallet_id, account_code, points_delta) VALUES ($1, NULL, 'system_settlement', $2)`, [ledger.rows[0].id, -(Number(row.price_points) - frozen)]);
      await client.query(`UPDATE wallets SET available_points = available_points + $2, frozen_points = frozen_points - $3, updated_at = now() WHERE id = $1`, [row.wallet_id, row.price_points, frozen]);
      await client.query(`UPDATE enrolments SET status = 'refunded' WHERE order_item_id = $1`, [row.order_item_id]);
      await client.query(`UPDATE earnings_allocations SET status = 'reversed' WHERE order_item_id = $1 AND status = 'pending'`, [row.order_item_id]);
      await client.query(`UPDATE orders SET status = CASE WHEN (SELECT count(*) FROM order_items WHERE order_id = $1) = 1 THEN 'refunded' ELSE 'partially_refunded' END WHERE id = $1`, [row.order_id]);
    }
    await client.query(`INSERT INTO audit_logs (actor_id, action, target_type, target_id, reason, outcome, request_id) VALUES ($1, 'refund.decision', 'refund_request', $2, $3, 'success', $4)`, [admin.id, id, input.reason, res.locals.requestId]);
    return { id, status: input.decision, eligibility: currentEligibility };
  });
  return ok(res, response);
}
