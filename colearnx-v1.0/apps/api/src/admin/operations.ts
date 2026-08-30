import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { env } from '../config/env.js';
import { query, withTransaction } from '../db/database.js';
import { sha256 } from '../lib/crypto.js';
import { ApiError, ok } from '../lib/http.js';
import { idempotencyKey, parse, uuid } from '../lib/validation.js';
import { loadSystemPointAccount, postPointTransaction } from '../points/ledger.js';

const productKind = z.enum(['course_run', 'content_version']);
const revenuePolicyInput = z.object({
  policyCode: z.string().trim().min(3).max(100).regex(/^[a-z0-9][a-z0-9_-]*$/),
  platformShareBps: z.coerce.number().int().min(0).max(10_000),
  trainerShareBps: z.coerce.number().int().min(0).max(10_000).default(0),
  creatorShareBps: z.coerce.number().int().min(0).max(10_000).default(0),
}).superRefine((value, context) => {
  if (value.platformShareBps + value.trainerShareBps + value.creatorShareBps !== 10_000) {
    context.addIssue({ code: 'custom', message: 'Revenue shares must total 10,000 basis points.' });
  }
});
const packageInput = z.object({
  packageCode: z.string().trim().min(3).max(100).regex(/^[a-z0-9][a-z0-9_-]*$/),
  displayName: z.string().trim().min(3).max(150),
  amountMinor: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  pointsAmount: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  active: z.boolean().default(false),
});
const adjustmentInput = z.object({
  userId: uuid,
  deltaPoints: z.coerce.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).refine((value) => value !== 0),
  reason: z.string().trim().min(8).max(1_000),
});
const cancellationInput = z.object({ reason: z.string().trim().min(8).max(2_000) });

export async function setRevenueSharePolicy(req: Request, res: Response) {
  const admin = res.locals.actor as Actor;
  const kind = parse(productKind, req.params.kind);
  const input = parse(revenuePolicyInput, req.body);
  if (kind === 'course_run' && input.creatorShareBps !== 0) {
    throw new ApiError(400, 'REVENUE_POLICY_INVALID', 'Course-run policies cannot allocate a creator share.');
  }
  if (kind === 'content_version' && input.trainerShareBps !== 0) {
    throw new ApiError(400, 'REVENUE_POLICY_INVALID', 'Content-version policies cannot allocate a trainer share.');
  }
  const response = await withTransaction(async (client) => {
    await client.query(`UPDATE revenue_share_policies SET is_active = false, retired_at = now()
      WHERE product_kind = $1 AND is_active = true`, [kind]);
    const inserted = await client.query<{ revenue_share_policy_id: string }>(`INSERT INTO revenue_share_policies
      (product_kind, policy_code, platform_share_bps, trainer_share_bps, creator_share_bps, is_active)
      VALUES ($1, $2, $3, $4, $5, true) RETURNING revenue_share_policy_id`,
      [kind, input.policyCode, input.platformShareBps, input.trainerShareBps, input.creatorShareBps]);
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, 'revenue_share_policy.activate', 'revenue_share_policies', $2,
      jsonb_build_object('productKind', $3::text, 'platformShareBps', $4::integer, 'trainerShareBps', $5::integer, 'creatorShareBps', $6::integer), $7)`,
      [admin.id, inserted.rows[0].revenue_share_policy_id, kind, input.platformShareBps, input.trainerShareBps, input.creatorShareBps, res.locals.requestId]);
    return { id: inserted.rows[0].revenue_share_policy_id, kind, ...input, active: true };
  });
  return ok(res, response, 201);
}

export async function createTopUpPackage(req: Request, res: Response) {
  const admin = res.locals.actor as Actor;
  const input = parse(packageInput, req.body);
  const response = await withTransaction(async (client) => {
    const existing = await client.query<{ point_topup_package_id: string }>(`SELECT point_topup_package_id FROM point_topup_packages
      WHERE package_code = $1 FOR UPDATE`, [input.packageCode]);
    let packageId: string;
    if (existing.rowCount) {
      packageId = existing.rows[0].point_topup_package_id;
      await client.query(`UPDATE point_topup_packages SET display_name = $2, currency_code = $3, fiat_amount = $4,
        points_amount = $5, is_active = $6, retired_at = NULL WHERE point_topup_package_id = $1`,
        [packageId, input.displayName, env.STRIPE_CURRENCY, input.amountMinor, input.pointsAmount, input.active]);
    } else {
      const inserted = await client.query<{ point_topup_package_id: string }>(`INSERT INTO point_topup_packages
        (package_code, display_name, currency_code, fiat_amount, points_amount, is_active)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING point_topup_package_id`,
        [input.packageCode, input.displayName, env.STRIPE_CURRENCY, input.amountMinor, input.pointsAmount, input.active]);
      packageId = inserted.rows[0].point_topup_package_id;
    }
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, 'topup_package.upsert', 'point_topup_packages', $2,
      jsonb_build_object('amountMinor', $3::bigint, 'pointsAmount', $4::bigint, 'currency', $5::text, 'active', $6::boolean), $7)`,
      [admin.id, packageId, input.amountMinor, input.pointsAmount, env.STRIPE_CURRENCY, input.active, res.locals.requestId]);
    return { id: packageId, currency: env.STRIPE_CURRENCY, ...input };
  });
  return ok(res, response, 201);
}

export async function retireTopUpPackage(req: Request, res: Response) {
  const admin = res.locals.actor as Actor;
  const packageId = parse(uuid, req.params.id);
  const result = await withTransaction(async (client) => {
    const retired = await client.query(`UPDATE point_topup_packages SET is_active = false, retired_at = now()
      WHERE point_topup_package_id = $1 AND retired_at IS NULL RETURNING point_topup_package_id`, [packageId]);
    if (!retired.rowCount) throw new ApiError(404, 'TOP_UP_PACKAGE_NOT_FOUND', 'Active top-up package was not found.');
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, request_id)
      VALUES ($1, 'topup_package.retire', 'point_topup_packages', $2, $3)`, [admin.id, packageId, res.locals.requestId]);
    return { id: packageId, retired: true };
  });
  return ok(res, result);
}

export async function adjustPoints(req: Request, res: Response) {
  const admin = res.locals.actor as Actor;
  const input = parse(adjustmentInput, req.body);
  const key = parse(idempotencyKey, req.get('idempotency-key'));
  const fingerprint = sha256(JSON.stringify(input));
  const response = await withTransaction(async (client) => {
    const existing = await client.query<{ request_fingerprint: string; response_body: { pointTransactionId: string; deltaPoints: number } | null }>(`SELECT request_fingerprint, response_body
      FROM idempotency_records WHERE actor_user_id = $1 AND operation_scope = 'admin.points.adjustment' AND idempotency_key = $2 FOR UPDATE`, [admin.id, key]);
    if (existing.rowCount) {
      if (existing.rows[0].request_fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different adjustment.');
      if (existing.rows[0].response_body) return existing.rows[0].response_body;
      throw new ApiError(409, 'REQUEST_IN_PROGRESS', 'The matching adjustment is still processing.');
    }
    await client.query(`INSERT INTO idempotency_records (actor_user_id, operation_scope, idempotency_key, request_fingerprint)
      VALUES ($1, 'admin.points.adjustment', $2, $3)`, [admin.id, key, fingerprint]);
    const recipient = await client.query<{ point_account_id: string }>(`SELECT point_account_id FROM point_accounts
      WHERE user_id = $1 AND account_status IN ('active', 'restricted')`, [input.userId]);
    if (!recipient.rowCount) throw new ApiError(404, 'POINT_ACCOUNT_NOT_FOUND', 'Recipient point account was not found.');
    const system = await loadSystemPointAccount(client);
    const delta = input.deltaPoints;
    const pointTransactionId = await postPointTransaction(client, {
      type: 'admin_adjustment', reason: input.reason, idempotencyKey: `admin-adjustment:${admin.id}:${key}`,
      entries: [
        { pointAccountId: recipient.rows[0].point_account_id, entryRole: delta > 0 ? 'member_available_credit' : 'member_available_debit', availableDelta: delta },
        { pointAccountId: system.point_account_id, entryRole: delta > 0 ? 'system_adjustment_debit' : 'system_adjustment_credit', availableDelta: -delta },
      ],
    });
    const body = { pointTransactionId, userId: input.userId, deltaPoints: delta };
    await client.query(`UPDATE idempotency_records SET response_status = 201, response_body = $4::jsonb, completed_at = now()
      WHERE actor_user_id = $1 AND operation_scope = 'admin.points.adjustment' AND idempotency_key = $2 AND request_fingerprint = $3`,
      [admin.id, key, fingerprint, JSON.stringify(body)]);
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, 'points.adjust', 'point_transactions', $2,
      jsonb_build_object('recipientUserId', $3::uuid, 'deltaPoints', $4::bigint, 'reason', $5::text, 'outcome', 'success'), $6)`,
      [admin.id, pointTransactionId, input.userId, delta, input.reason, res.locals.requestId]);
    return body;
  });
  return ok(res, response, 201);
}

type ActiveHold = { point_hold_id: string; order_item_id: string; point_account_id: string; points_amount: string };

async function activeHolds(client: PoolClient, courseRunId: string): Promise<ActiveHold[]> {
  const holds = await client.query<ActiveHold>(`SELECT ph.point_hold_id, pt.order_item_id, pa.point_account_id, ph.points_amount
    FROM point_holds ph
    JOIN point_transactions pt ON pt.point_transaction_id = ph.purchase_transaction_id
    JOIN order_items oi ON oi.order_item_id = pt.order_item_id
    JOIN course_enrolments ce ON ce.order_item_id = oi.order_item_id
    JOIN point_accounts pa ON pa.user_id = ce.learner_user_id AND pa.account_status IN ('active', 'restricted')
    WHERE oi.course_run_id = $1 AND ph.hold_status = 'active'
    ORDER BY ph.point_hold_id FOR UPDATE OF ph, oi, ce, pa`, [courseRunId]);
  return holds.rows;
}

function amount(value: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ApiError(409, 'INVALID_HOLD_AMOUNT', 'Held points amount is invalid.');
  return parsed;
}

export async function completeLiveCourseRun(req: Request, res: Response) {
  const admin = res.locals.actor as Actor;
  const courseRunId = parse(uuid, req.params.id);
  const response = await withTransaction(async (client) => {
    const run = await client.query<{ course_run_id: string }>(`SELECT course_run_id FROM course_runs
      WHERE course_run_id = $1 AND run_status = 'published' AND starts_at IS NOT NULL AND starts_at <= now()
        AND EXISTS (SELECT 1 FROM course_delivery_options cdo WHERE cdo.course_run_id = course_runs.course_run_id
          AND cdo.delivery_type = 'live' AND cdo.option_status = 'active')
      FOR UPDATE`, [courseRunId]);
    if (!run.rowCount) throw new ApiError(409, 'COURSE_RUN_NOT_COMPLETABLE', 'Only a started published course run can be completed.');
    const system = await loadSystemPointAccount(client);
    const holds = await activeHolds(client, courseRunId);
    for (const hold of holds) {
      const releaseTransactionId = await postPointTransaction(client, {
        type: 'live_settlement', reason: 'live_course_completed_settlement', idempotencyKey: `live-settlement:${hold.point_hold_id}`,
        orderItemId: hold.order_item_id,
        entries: [
          { pointAccountId: hold.point_account_id, entryRole: 'member_frozen_debit', frozenDelta: -amount(hold.points_amount) },
          { pointAccountId: system.point_account_id, entryRole: 'platform_settlement_credit', availableDelta: amount(hold.points_amount) },
        ],
      });
      await client.query(`UPDATE point_holds SET seller_account_id = $2, release_transaction_id = $3, hold_status = 'released',
        release_trigger = 'course_completed', release_at = now(), released_at = now() WHERE point_hold_id = $1`,
        [hold.point_hold_id, system.point_account_id, releaseTransactionId]);
    }
    await client.query(`UPDATE order_items SET fulfilment_status = 'fulfilled'
      WHERE course_run_id = $1 AND fulfilment_status = 'reserved'`, [courseRunId]);
    await client.query(`UPDATE earnings_allocations SET allocation_status = 'settled' WHERE order_item_id IN
      (SELECT order_item_id FROM order_items WHERE course_run_id = $1) AND allocation_status = 'pending'`, [courseRunId]);
    await client.query(`UPDATE course_runs SET run_status = 'completed' WHERE course_run_id = $1`, [courseRunId]);
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, 'course_run.complete', 'course_runs', $2, jsonb_build_object('settledHolds', $3::integer, 'outcome', 'success'), $4)`,
      [admin.id, courseRunId, holds.length, res.locals.requestId]);
    return { id: courseRunId, status: 'completed', settledHolds: holds.length };
  });
  return ok(res, response);
}

export async function cancelLiveCourseRun(req: Request, res: Response) {
  const admin = res.locals.actor as Actor;
  const courseRunId = parse(uuid, req.params.id);
  const input = parse(cancellationInput, req.body);
  const response = await withTransaction(async (client) => {
    const run = await client.query<{ course_run_id: string }>(`SELECT course_run_id FROM course_runs
      WHERE course_run_id = $1 AND run_status = 'published'
        AND EXISTS (SELECT 1 FROM course_delivery_options cdo WHERE cdo.course_run_id = course_runs.course_run_id
          AND cdo.delivery_type = 'live' AND cdo.option_status = 'active')
      FOR UPDATE`, [courseRunId]);
    if (!run.rowCount) throw new ApiError(409, 'COURSE_RUN_NOT_CANCELLABLE', 'Only a published course run can be cancelled.');
    const holds = await activeHolds(client, courseRunId);
    for (const hold of holds) {
      const refundTransactionId = await postPointTransaction(client, {
        type: 'refund', reason: 'live_course_cancelled_refund', idempotencyKey: `course-cancel:${hold.point_hold_id}`,
        orderItemId: hold.order_item_id,
        entries: [
          { pointAccountId: hold.point_account_id, entryRole: 'member_frozen_debit', frozenDelta: -amount(hold.points_amount) },
          { pointAccountId: hold.point_account_id, entryRole: 'member_available_credit', availableDelta: amount(hold.points_amount) },
        ],
      });
      await client.query(`UPDATE point_holds SET release_transaction_id = $2, hold_status = 'cancelled',
        release_trigger = 'course_cancelled', release_at = now(), cancelled_at = now() WHERE point_hold_id = $1`,
        [hold.point_hold_id, refundTransactionId]);
    }
    await client.query(`UPDATE order_items SET fulfilment_status = 'refunded'
      WHERE course_run_id = $1 AND fulfilment_status = 'reserved'`, [courseRunId]);
    await client.query(`UPDATE course_enrolments SET enrolment_status = 'refunded'
      WHERE course_run_id = $1 AND enrolment_status IN ('active', 'confirmed', 'in_progress')`, [courseRunId]);
    await client.query(`UPDATE refund_requests SET refund_status = 'cancelled', reviewed_by_user_id = $2, reviewed_at = now(),
      decision_note = 'Course cancelled: points returned automatically.'
      WHERE refund_status = 'pending' AND order_item_id IN (SELECT order_item_id FROM order_items WHERE course_run_id = $1)`,
      [courseRunId, admin.id]);
    await client.query(`UPDATE earnings_allocations SET allocation_status = 'reversed' WHERE order_item_id IN
      (SELECT order_item_id FROM order_items WHERE course_run_id = $1) AND allocation_status = 'pending'`, [courseRunId]);
    await client.query(`UPDATE orders o SET order_status = CASE
      WHEN NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.order_id AND oi.fulfilment_status <> 'refunded') THEN 'refunded'
      ELSE 'partially_refunded' END, updated_at = now()
      WHERE EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.order_id AND oi.course_run_id = $1)`, [courseRunId]);
    await client.query(`UPDATE course_runs SET run_status = 'cancelled' WHERE course_run_id = $1`, [courseRunId]);
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, 'course_run.cancel', 'course_runs', $2,
      jsonb_build_object('refundedHolds', $3::integer, 'reason', $4::text, 'outcome', 'success'), $5)`,
      [admin.id, courseRunId, holds.length, input.reason, res.locals.requestId]);
    return { id: courseRunId, status: 'cancelled', refundedHolds: holds.length };
  });
  return ok(res, response);
}
