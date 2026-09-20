import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { query, withTransaction } from '../db/database.js';
import { ApiError, ok } from '../lib/http.js';
import { parse, uuid } from '../lib/validation.js';
import { loadSystemPointAccount, postPointTransaction } from '../points/ledger.js';
import { evaluateRefund, type RefundDecision } from './policy.js';
import { uniqueWatchedSeconds } from '../video/progress.js';

const requestSchema = z.object({ orderItemId: uuid, reason: z.string().trim().min(5).max(2000) });
const decisionSchema = z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string().trim().min(3).max(2000) });
const reviewListSchema = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

type RefundEvidence = {
  order_item_id: string;
  course_video_version_id: string | null;
  item_type: string;
  fulfilment_status: string;
  points_amount: string;
  delivery_modes_snapshot_json: unknown;
  refund_policy_snapshot_json: unknown;
  purchased_at: Date;
  starts_at: Date | null;
  watched_seconds: string;
  total_seconds: string | null;
  first_accessed_at: Date | null;
  download_completed_at: Date | null;
};

function modes(value: unknown) {
  return Array.isArray(value) ? value.filter((mode): mode is string => typeof mode === 'string') : [];
}

function evaluateEvidence(evidence: RefundEvidence, requestTime: Date): RefundDecision {
  return evaluateRefund({
    policySnapshot: evidence.refund_policy_snapshot_json,
    requestTime,
    purchasedAt: evidence.purchased_at,
    watchedSeconds: Number(evidence.watched_seconds),
    totalDurationSeconds: evidence.total_seconds === null ? null : Number(evidence.total_seconds),
    downloadCompletedAt: evidence.download_completed_at,
  });
}

async function loadEvidence(client: Pick<PoolClient, 'query'>, orderItemId: string, buyerId: string) {
  // Lock the order before its evidence. Heartbeats take the same first lock,
  // so a refund snapshot cannot race an accepted interval write.
  const locked = await client.query<{ course_video_version_id: string | null }>(`SELECT oi.course_video_version_id
    FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
    WHERE oi.order_item_id = $1 AND o.buyer_user_id = $2 FOR UPDATE OF oi`, [orderItemId, buyerId]);
  const videoVersionId = locked.rows[0]?.course_video_version_id;
  if (!locked.rowCount) return null;
  await client.query(`SELECT ce.enrolment_id FROM course_enrolments ce
    WHERE ce.order_item_id = $1 FOR UPDATE`, [orderItemId]);
  await client.query(`SELECT cap.access_progress_id FROM course_access_progress cap
    JOIN course_enrolments ce ON ce.enrolment_id = cap.enrolment_id
    WHERE ce.order_item_id = $1 FOR UPDATE OF cap`, [orderItemId]);
  if (videoVersionId) await client.query(`SELECT course_video_watch_interval_id FROM course_video_watch_intervals
    WHERE order_item_id = $1 AND course_video_version_id = $2 FOR UPDATE`, [orderItemId, videoVersionId]);

  const result = await client.query<RefundEvidence>(`SELECT oi.order_item_id, oi.course_video_version_id, oi.item_type, oi.fulfilment_status, oi.points_amount,
    oi.delivery_modes_snapshot_json, oi.refund_policy_snapshot_json, o.created_at AS purchased_at, cr.starts_at,
    COALESCE(MAX(cap.watched_seconds), 0)::text AS watched_seconds,
    COALESCE(cv.duration_seconds, MAX(cap.total_seconds))::text AS total_seconds,
    COALESCE(MIN(cap.first_started_at), MIN(cag.first_accessed_at)) AS first_accessed_at,
    COALESCE(MAX(cap.download_completed_at), MAX(cag.first_accessed_at)) AS download_completed_at
    FROM order_items oi
    JOIN orders o ON o.order_id = oi.order_id
    LEFT JOIN course_runs cr ON cr.course_run_id = oi.course_run_id
    LEFT JOIN course_video_versions cv ON cv.course_video_version_id = oi.course_video_version_id
    LEFT JOIN course_enrolments ce ON ce.order_item_id = oi.order_item_id
    LEFT JOIN course_access_progress cap ON cap.enrolment_id = ce.enrolment_id
    LEFT JOIN content_access_grants cag ON cag.order_item_id = oi.order_item_id
    WHERE oi.order_item_id = $1 AND o.buyer_user_id = $2
    GROUP BY oi.order_item_id, oi.course_video_version_id, o.order_id, cr.course_run_id, cv.duration_seconds`,
    [orderItemId, buyerId]);
  const evidence = result.rows[0] ?? null;
  if (evidence?.course_video_version_id && evidence.total_seconds !== null) {
    const intervals = await client.query<{ interval_start_seconds: string; interval_end_seconds: string }>(`SELECT interval_start_seconds::text, interval_end_seconds::text
      FROM course_video_watch_intervals WHERE order_item_id = $1 AND course_video_version_id = $2`, [orderItemId, evidence.course_video_version_id]);
    evidence.watched_seconds = String(uniqueWatchedSeconds(intervals.rows.map((row) => ({ startSeconds: Number(row.interval_start_seconds), endSeconds: Number(row.interval_end_seconds) })), Number(evidence.total_seconds)));
  }
  return evidence;
}

export async function createRefundRequest(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(requestSchema, req.body);
  const response = await withTransaction(async (client) => {
    const evidence = await loadEvidence(client, input.orderItemId, actor.id);
    if (!evidence) throw new ApiError(404, 'ORDER_ITEM_NOT_FOUND', 'This purchased item was not found.');
    if (evidence.fulfilment_status === 'refunded' || evidence.fulfilment_status === 'cancelled') {
      throw new ApiError(409, 'ORDER_ITEM_ALREADY_REFUNDED', 'This order item has already been refunded or cancelled.');
    }
    const requestedAt = new Date();
    const eligibility = evaluateEvidence(evidence, requestedAt);
    if (!eligibility.eligible) {
      throw new ApiError(409, 'REFUND_NOT_ELIGIBLE', eligibility.explanation, { policyCode: eligibility.code });
    }
    const watchedSeconds = Math.max(0, Number(evidence.watched_seconds));
    const totalDurationSeconds = Math.max(0, Number(evidence.total_seconds ?? 0));
    const watchPercent = totalDurationSeconds > 0 ? Number(((watchedSeconds / totalDurationSeconds) * 100).toFixed(2)) : 0;
    const inserted = await client.query<{ refund_request_id: string; refund_status: string; requested_at: Date }>(`INSERT INTO refund_requests
      (order_item_id, requested_by_user_id, requested_points, refund_reason, eligibility_code, watch_percent_snapshot,
       first_accessed_at_snapshot, download_completed_at_snapshot, policy_snapshot_json, eligibility_snapshot_json)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
      RETURNING refund_request_id, refund_status, requested_at`, [
      evidence.order_item_id, actor.id, evidence.points_amount, input.reason, eligibility.code, watchPercent,
      evidence.first_accessed_at, evidence.download_completed_at,
      JSON.stringify(evidence.refund_policy_snapshot_json),
      JSON.stringify({ ...eligibility, evaluatedAt: requestedAt.toISOString(), deliveryModes: modes(evidence.delivery_modes_snapshot_json),
        watchedSeconds, totalDurationSeconds, downloadRecorded: Boolean(evidence.download_completed_at) }),
    ]);
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, 'refund.request', 'refund_requests', $2, jsonb_build_object('policyCode', $3::text, 'outcome', 'success'), $4)`,
      [actor.id, inserted.rows[0].refund_request_id, eligibility.code, res.locals.requestId]);
    return inserted.rows[0];
  });
  return ok(res, { id: response.refund_request_id, status: response.refund_status, requestedAt: response.requested_at }, 201);
}

export async function getRefundRequest(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const refundRequestId = parse(uuid, req.params.id);
  const result = await query(`SELECT refund_request_id, refund_status, refund_reason, requested_points, requested_at,
    reviewed_at, decision_note, eligibility_code, eligibility_snapshot_json, policy_snapshot_json, resulting_point_transaction_id
    FROM refund_requests WHERE refund_request_id = $1 AND requested_by_user_id = $2`, [refundRequestId, actor.id]);
  if (!result.rowCount) throw new ApiError(404, 'REFUND_REQUEST_NOT_FOUND', 'Refund request was not found.');
  const row = result.rows[0];
  return ok(res, { id: row.refund_request_id, status: row.refund_status, reason: row.refund_reason,
    requestedPoints: Number(row.requested_points), requestedAt: row.requested_at, decidedAt: row.reviewed_at,
    decisionReason: row.decision_note, policyCode: row.eligibility_code, eligibility: row.eligibility_snapshot_json,
    policy: row.policy_snapshot_json, pointTransactionId: row.resulting_point_transaction_id });
}

export async function listRefundRequestsForAdmin(req: Request, res: Response) {
  const input = parse(reviewListSchema, req.query);
  const result = await query(`SELECT rr.refund_request_id, rr.refund_status, rr.refund_reason, rr.requested_points,
    rr.requested_at, rr.reviewed_at, rr.decision_note, rr.eligibility_code, rr.eligibility_snapshot_json,
    rr.policy_snapshot_json, rr.resulting_point_transaction_id, oi.order_item_id, oi.item_title_snapshot,
    oi.item_type, requester.user_id AS requester_user_id, requester.full_name AS requester_name
    FROM refund_requests rr
    JOIN order_items oi ON oi.order_item_id = rr.order_item_id
    JOIN users requester ON requester.user_id = rr.requested_by_user_id
    WHERE ($1::text IS NULL OR rr.refund_status = $1)
    ORDER BY rr.requested_at ASC, rr.refund_request_id ASC LIMIT $2`, [input.status ?? null, input.limit]);
  return ok(res, result.rows.map((row) => ({
    id: row.refund_request_id, status: row.refund_status, reason: row.refund_reason,
    requestedPoints: Number(row.requested_points), requestedAt: row.requested_at, decidedAt: row.reviewed_at,
    decisionReason: row.decision_note, policyCode: row.eligibility_code, eligibility: row.eligibility_snapshot_json,
    policy: row.policy_snapshot_json, pointTransactionId: row.resulting_point_transaction_id,
    item: { id: row.order_item_id, title: row.item_title_snapshot, kind: row.item_type },
    requester: { id: row.requester_user_id, displayName: row.requester_name },
  })));
}

export async function decideRefund(req: Request, res: Response) {
  const admin = res.locals.actor as Actor;
  const refundRequestId = parse(uuid, req.params.id);
  const input = parse(decisionSchema, req.body);
  const response = await withTransaction(async (client) => {
    // Lock the system counterparty before the member account so every
    // system-backed point transfer uses the same lock order as checkout.
    const system = await loadSystemPointAccount(client);
    const request = await client.query<{
      refund_request_id: string;
      refund_status: string;
      order_item_id: string;
      requested_by_user_id: string;
      requested_points: string;
      eligibility_snapshot_json: { eligible?: boolean; deliveryModes?: unknown };
      order_id: string;
      fulfilment_status: string;
      point_account_id: string;
    }>(`SELECT rr.refund_request_id, rr.refund_status, rr.order_item_id, rr.requested_by_user_id, rr.requested_points,
      rr.eligibility_snapshot_json, oi.order_id, oi.fulfilment_status, pa.point_account_id
      FROM refund_requests rr
      JOIN order_items oi ON oi.order_item_id = rr.order_item_id
      JOIN point_accounts pa ON pa.user_id = rr.requested_by_user_id AND pa.account_status IN ('active', 'restricted')
      WHERE rr.refund_request_id = $1
      FOR UPDATE OF rr, oi, pa`, [refundRequestId]);
    if (!request.rowCount) throw new ApiError(404, 'REFUND_REQUEST_NOT_FOUND', 'Refund request was not found.');
    const current = request.rows[0];
    if (current.refund_status !== 'pending') throw new ApiError(409, 'REFUND_ALREADY_DECIDED', 'This refund request has already been decided.');
    if (current.fulfilment_status === 'refunded' || current.fulfilment_status === 'cancelled') {
      throw new ApiError(409, 'ORDER_ITEM_ALREADY_REFUNDED', 'This order item has already been refunded or cancelled.');
    }
    if (input.decision === 'approved' && !current.eligibility_snapshot_json?.eligible) {
      throw new ApiError(409, 'REFUND_NOT_ELIGIBLE', 'The recorded request did not meet the refund policy.');
    }
    const isLiveRefund = Array.isArray(current.eligibility_snapshot_json?.deliveryModes)
      && current.eligibility_snapshot_json.deliveryModes.includes('live');
    if (input.decision === 'approved' && isLiveRefund && current.fulfilment_status !== 'reserved') {
      throw new ApiError(409, 'LIVE_REFUND_NO_LONGER_AVAILABLE', 'The live-course hold has already been released.');
    }
    await client.query(`UPDATE refund_requests SET refund_status = $2, reviewed_by_user_id = $3, reviewed_at = now(), decision_note = $4
      WHERE refund_request_id = $1`, [refundRequestId, input.decision, admin.id, input.reason]);
    let pointTransactionId: string | null = null;
    if (input.decision === 'approved') {
      const isReservedLive = current.fulfilment_status === 'reserved';
      const requestedPoints = Number(current.requested_points);
      if (requestedPoints > 0) {
        pointTransactionId = await postPointTransaction(client, isReservedLive ? {
          type: 'refund', reason: 'eligible_live_refund', idempotencyKey: `refund:${refundRequestId}`,
          orderItemId: current.order_item_id, refundRequestId,
          entries: [
            { pointAccountId: current.point_account_id, entryRole: 'member_frozen_debit', frozenDelta: -requestedPoints },
            { pointAccountId: current.point_account_id, entryRole: 'member_available_credit', availableDelta: requestedPoints },
          ],
        } : {
          type: 'refund', reason: 'eligible_purchase_refund', idempotencyKey: `refund:${refundRequestId}`,
          orderItemId: current.order_item_id, refundRequestId,
          entries: [
            { pointAccountId: current.point_account_id, entryRole: 'member_available_credit', availableDelta: requestedPoints },
            { pointAccountId: system.point_account_id, entryRole: 'platform_settlement_debit', availableDelta: -requestedPoints },
          ],
        });
        await client.query(`UPDATE refund_requests SET resulting_point_transaction_id = $2 WHERE refund_request_id = $1`, [refundRequestId, pointTransactionId]);
      }
      if (isReservedLive && pointTransactionId) {
        await client.query(`UPDATE point_holds ph SET release_transaction_id = $2, hold_status = 'cancelled',
          release_trigger = 'refund_approved', release_at = now(), cancelled_at = now()
          FROM point_transactions purchase
          WHERE ph.purchase_transaction_id = purchase.point_transaction_id
            AND purchase.order_item_id = $1 AND ph.hold_status = 'active'`, [current.order_item_id, pointTransactionId]);
      }
      await client.query(`UPDATE order_items SET fulfilment_status = 'refunded' WHERE order_item_id = $1`, [current.order_item_id]);
      await client.query(`UPDATE course_video_progress_sessions SET session_status = 'revoked', updated_at = now()
        WHERE order_item_id = $1 AND session_status = 'active'`, [current.order_item_id]);
      await client.query(`UPDATE course_enrolments SET enrolment_status = 'refunded' WHERE order_item_id = $1`, [current.order_item_id]);
      await client.query(`UPDATE content_access_grants SET expires_at = now() WHERE order_item_id = $1`, [current.order_item_id]);
      await client.query(`UPDATE earnings_allocations SET allocation_status = 'reversed'
        WHERE order_item_id = $1 AND allocation_status = 'pending'`, [current.order_item_id]);
      await client.query(`UPDATE orders SET order_status = CASE
        WHEN NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = $1 AND fulfilment_status <> 'refunded') THEN 'refunded'
        ELSE 'partially_refunded' END, updated_at = now() WHERE order_id = $1`, [current.order_id]);
    }
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, 'refund.decision', 'refund_requests', $2,
        jsonb_build_object('decision', $3::text, 'reason', $4::text, 'pointTransactionId', $5::uuid, 'outcome', 'success'), $6)`,
      [admin.id, refundRequestId, input.decision, input.reason, pointTransactionId, res.locals.requestId]);
    return { id: refundRequestId, status: input.decision, pointTransactionId };
  });
  return ok(res, response);
}
