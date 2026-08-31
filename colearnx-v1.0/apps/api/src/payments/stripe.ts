import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { env } from '../config/env.js';
import { withTransaction, query } from '../db/database.js';
import { sha256 } from '../lib/crypto.js';
import { ApiError, ok } from '../lib/http.js';
import { idempotencyKey, parse, uuid } from '../lib/validation.js';
import { loadSystemPointAccount, postPointTransaction } from '../points/ledger.js';
import type { Actor } from '../auth/auth.js';
import { requireStripeSandboxSecret, stripeCheckoutError, stripeFailureLogFields } from './stripe-support.js';

const checkoutSchema = z.object({ topUpPackageId: uuid });

function stripeClient() {
  return new Stripe(requireStripeSandboxSecret(env.STRIPE_SECRET_KEY));
}

type PaymentRow = {
  payment_transaction_id: string;
  topup_order_id: string;
  point_account_id: string;
  user_id: string;
  amount: string;
  currency_code: string;
  points_amount: string;
  payment_status: string;
  provider_transaction_id: string | null;
};

type CheckoutResponse = {
  paymentTransactionId: string;
  topUpOrderId: string;
  checkoutUrl: string;
  status: 'pending';
};

async function claimIdempotency(client: PoolClient, actorId: string, scope: string, key: string, fingerprint: string) {
  const existing = await client.query<{ request_fingerprint: string; response_status: number | null; response_body: CheckoutResponse | null }>(`SELECT request_fingerprint, response_status, response_body
    FROM idempotency_records
    WHERE actor_user_id = $1 AND operation_scope = $2 AND idempotency_key = $3
    FOR UPDATE`, [actorId, scope, key]);
  if (existing.rowCount) {
    if (existing.rows[0].request_fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was used for a different request.');
    if (existing.rows[0].response_status && existing.rows[0].response_body) return existing.rows[0].response_body;
    throw new ApiError(409, 'REQUEST_IN_PROGRESS', 'An identical request is already being processed.');
  }
  await client.query(`INSERT INTO idempotency_records (actor_user_id, operation_scope, idempotency_key, request_fingerprint)
    VALUES ($1, $2, $3, $4)`, [actorId, scope, key, fingerprint]);
  return null;
}

function asSafePositiveInteger(value: string, field: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new ApiError(409, 'INVALID_TOP_UP_PACKAGE', `${field} must be a supported positive integer.`);
  }
  return number;
}

export async function createCheckoutSession(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(checkoutSchema, req.body);
  const key = parse(idempotencyKey, req.get('idempotency-key'));
  const fingerprint = sha256(JSON.stringify(input));
  const scope = 'wallet.topup.checkout';
  // Fail before creating local orders when the sandbox is not configured.
  // Keeping this outside the Stripe API catch preserves STRIPE_NOT_CONFIGURED as a 503.
  const stripe = stripeClient();
  const prepared = await withTransaction(async (client) => {
    const cached = await claimIdempotency(client, actor.id, scope, key, fingerprint);
    if (cached) return { cached };
    const packageResult = await client.query<{
      point_topup_package_id: string;
      display_name: string;
      fiat_amount: string;
      currency_code: string;
      points_amount: string;
    }>(`SELECT point_topup_package_id, display_name, fiat_amount, currency_code, points_amount
      FROM point_topup_packages
      WHERE point_topup_package_id = $1 AND is_active = true AND retired_at IS NULL
      FOR SHARE`, [input.topUpPackageId]);
    if (!packageResult.rowCount) throw new ApiError(404, 'TOP_UP_PACKAGE_NOT_AVAILABLE', 'This top-up package is not available.');
    const pkg = packageResult.rows[0];
    if (pkg.currency_code !== env.STRIPE_CURRENCY) {
      throw new ApiError(409, 'TOP_UP_CURRENCY_MISMATCH', 'This package currency is not configured for Stripe.');
    }
    const amountMinor = asSafePositiveInteger(pkg.fiat_amount, 'Top-up amount');
    asSafePositiveInteger(pkg.points_amount, 'Top-up points');
    const account = await client.query<{ point_account_id: string }>(`SELECT point_account_id FROM point_accounts
      WHERE user_id = $1 AND account_status = 'active' FOR SHARE`, [actor.id]);
    if (!account.rowCount) throw new ApiError(409, 'POINT_ACCOUNT_NOT_FOUND', 'Your point account is unavailable.');
    const channel = await client.query<{ payment_channel_id: string }>(`SELECT payment_channel_id FROM payment_channels
      WHERE channel_code = 'stripe_test' AND provider_code = 'stripe' AND is_enabled = true FOR SHARE`);
    if (!channel.rowCount) throw new ApiError(503, 'STRIPE_CHANNEL_DISABLED', 'Stripe test payments are not enabled.');
    const topupOrder = await client.query<{ topup_order_id: string }>(`INSERT INTO point_topup_orders
      (point_account_id, points_amount, fiat_amount, currency_code, topup_no)
      VALUES ($1, $2, $3, $4, $5) RETURNING topup_order_id`, [
      account.rows[0].point_account_id, pkg.points_amount, pkg.fiat_amount, pkg.currency_code, `TOP-${randomUUID()}`,
    ]);
    const payment = await client.query<{ payment_transaction_id: string }>(`INSERT INTO payment_transactions
      (topup_order_id, payment_channel_id, amount, currency_code, idempotency_key)
      VALUES ($1, $2, $3, $4, $5) RETURNING payment_transaction_id`, [
      topupOrder.rows[0].topup_order_id, channel.rows[0].payment_channel_id, pkg.fiat_amount, pkg.currency_code, `stripe-checkout:${randomUUID()}`,
    ]);
    return {
      paymentTransactionId: payment.rows[0].payment_transaction_id,
      topUpOrderId: topupOrder.rows[0].topup_order_id,
      displayName: pkg.display_name,
      amountMinor,
      currency: pkg.currency_code,
    };
  });
  if ('cached' in prepared) return ok(res, prepared.cached);
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: actor.email,
      line_items: [{ price_data: { currency: prepared.currency, product_data: { name: prepared.displayName }, unit_amount: prepared.amountMinor }, quantity: 1 }],
      success_url: `${env.APP_ORIGIN}/#/wallet?topUp=processing&paymentTransactionId=${prepared.paymentTransactionId}`,
      cancel_url: `${env.APP_ORIGIN}/#/wallet?topUp=cancelled`,
      metadata: { paymentTransactionId: prepared.paymentTransactionId, topUpOrderId: prepared.topUpOrderId, userId: actor.id },
    }, { idempotencyKey: `colearnx_${prepared.paymentTransactionId}` });
  } catch (error) {
    res.locals.log?.error({
      requestId: res.locals.requestId,
      stripe: stripeFailureLogFields(error),
      paymentTransactionId: prepared.paymentTransactionId,
    }, 'Stripe checkout session creation failed');
    await withTransaction(async (client) => {
      await client.query(`UPDATE payment_transactions SET payment_status = 'failed', failure_code = 'stripe_checkout_creation_failed'
        WHERE payment_transaction_id = $1`, [prepared.paymentTransactionId]);
      await client.query(`UPDATE point_topup_orders SET topup_status = 'failed' WHERE topup_order_id = $1`, [prepared.topUpOrderId]);
      await client.query(`DELETE FROM idempotency_records
        WHERE actor_user_id = $1 AND operation_scope = $2 AND idempotency_key = $3 AND request_fingerprint = $4`, [actor.id, scope, key, fingerprint]);
    });
    throw stripeCheckoutError(error);
  }
  if (!session.url) throw new ApiError(502, 'STRIPE_CHECKOUT_URL_MISSING', 'Stripe did not return a checkout URL.');
  const response: CheckoutResponse = { paymentTransactionId: prepared.paymentTransactionId, topUpOrderId: prepared.topUpOrderId, checkoutUrl: session.url, status: 'pending' };
  await withTransaction(async (client) => {
    await client.query(`UPDATE payment_transactions SET provider_transaction_id = $2, payment_status = 'checkout_created'
      WHERE payment_transaction_id = $1`, [prepared.paymentTransactionId, session.id]);
    await client.query(`UPDATE point_topup_orders SET topup_status = 'checkout_created' WHERE topup_order_id = $1`, [prepared.topUpOrderId]);
    await client.query(`UPDATE idempotency_records SET response_status = 201, response_body = $5::jsonb, completed_at = now()
      WHERE actor_user_id = $1 AND operation_scope = $2 AND idempotency_key = $3 AND request_fingerprint = $4`, [actor.id, scope, key, fingerprint, JSON.stringify(response)]);
  });
  return ok(res, response, 201);
}

function sessionIsPayable(session: Stripe.Checkout.Session, payment: PaymentRow) {
  return session.mode === 'payment'
    && session.payment_status === 'paid'
    && session.amount_total === asSafePositiveInteger(payment.amount, 'Payment amount')
    && session.currency === payment.currency_code
    && session.metadata?.paymentTransactionId === payment.payment_transaction_id
    && session.metadata?.topUpOrderId === payment.topup_order_id
    && session.metadata?.userId === payment.user_id;
}

export async function stripeWebhook(req: Request, res: Response) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new ApiError(503, 'STRIPE_WEBHOOK_NOT_CONFIGURED', 'Stripe webhook verification is not configured.');
  const signature = req.get('stripe-signature');
  if (!signature) throw new ApiError(400, 'STRIPE_SIGNATURE_MISSING', 'Stripe signature is missing.');
  // Configuration failures are operational 503s, not invalid webhook signatures.
  const stripe = stripeClient();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body as Buffer, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    throw new ApiError(400, 'STRIPE_SIGNATURE_INVALID', 'Stripe signature verification failed.');
  }
  if (env.STRIPE_MODE !== 'test' || event.livemode) throw new ApiError(400, 'STRIPE_LIVEMODE_REJECTED', 'Only Stripe test-mode events are accepted.');
  await withTransaction(async (client) => {
    const insertedEvent = await client.query<{ stripe_event_id: string }>(`INSERT INTO stripe_payment_events
      (stripe_event_id, event_type, payload_sha256, diagnostic_metadata)
      VALUES ($1, $2, $3, jsonb_build_object('livemode', $4::boolean))
      ON CONFLICT (stripe_event_id) DO NOTHING
      RETURNING stripe_event_id`, [event.id, event.type, sha256(req.body as Buffer), event.livemode]);
    if (!insertedEvent.rowCount) return;
    if (event.type !== 'checkout.session.completed') {
      await client.query(`UPDATE stripe_payment_events SET processing_status = 'ignored', processed_at = now() WHERE stripe_event_id = $1`, [event.id]);
      return;
    }
    const session = event.data.object as Stripe.Checkout.Session;
    // System is always locked first for any transfer that will credit a user;
    // checkout, refunds and administrative adjustments follow this same order.
    const system = await loadSystemPointAccount(client);
    const paymentResult = await client.query<PaymentRow>(`SELECT
      pt.payment_transaction_id, pt.topup_order_id, pto.point_account_id, pa.user_id,
      pt.amount, pt.currency_code, pto.points_amount, pt.payment_status, pt.provider_transaction_id
      FROM payment_transactions pt
      JOIN point_topup_orders pto ON pto.topup_order_id = pt.topup_order_id
      JOIN point_accounts pa ON pa.point_account_id = pto.point_account_id
      WHERE pt.provider_transaction_id = $1
      FOR UPDATE OF pt, pto, pa`, [session.id]);
    if (!paymentResult.rowCount || !sessionIsPayable(session, paymentResult.rows[0])) {
      await client.query(`UPDATE stripe_payment_events SET processing_status = 'failed', processed_at = now() WHERE stripe_event_id = $1`, [event.id]);
      throw new ApiError(400, 'STRIPE_PAYMENT_MISMATCH', 'Stripe payment does not match the local pending transaction.');
    }
    const payment = paymentResult.rows[0];
    await client.query(`UPDATE stripe_payment_events SET payment_transaction_id = $2 WHERE stripe_event_id = $1`, [event.id, payment.payment_transaction_id]);
    if (payment.payment_status === 'paid') {
      await client.query(`UPDATE stripe_payment_events SET processing_status = 'ignored', processed_at = now() WHERE stripe_event_id = $1`, [event.id]);
      return;
    }
    const points = asSafePositiveInteger(payment.points_amount, 'Top-up points');
    await postPointTransaction(client, {
      type: 'topup',
      reason: 'stripe_test_topup',
      idempotencyKey: `stripe-event:${event.id}`,
      topupOrderId: payment.topup_order_id,
      entries: [
        { pointAccountId: payment.point_account_id, entryRole: 'member_available_credit', availableDelta: points },
        { pointAccountId: system.point_account_id, entryRole: 'system_issuance_debit', availableDelta: -points },
      ],
    });
    await client.query(`UPDATE payment_transactions SET payment_status = 'paid', paid_at = now() WHERE payment_transaction_id = $1`, [payment.payment_transaction_id]);
    await client.query(`UPDATE point_topup_orders SET topup_status = 'paid', paid_at = now(), credited_at = now() WHERE topup_order_id = $1`, [payment.topup_order_id]);
    await client.query(`UPDATE stripe_payment_events SET processing_status = 'processed', processed_at = now() WHERE stripe_event_id = $1`, [event.id]);
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, 'payment.stripe_topup_posted', 'payment_transactions', $2,
      jsonb_build_object('points', $3::bigint, 'stripeEventId', $4::text, 'outcome', 'success'), $5)`,
      [payment.user_id, payment.payment_transaction_id, payment.points_amount, event.id, res.locals.requestId]);
    await client.query(`INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
      VALUES ('point_topup_order', $1, 'wallet.top_up.posted', jsonb_build_object('topUpOrderId', $1::uuid))`, [payment.topup_order_id]);
  });
  return ok(res, { received: true });
}

export async function getTopUp(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const paymentTransactionId = parse(uuid, req.params.id);
  const result = await query(`SELECT pt.payment_transaction_id, pt.payment_status, pto.topup_order_id,
    pto.points_amount, pt.amount, pt.currency_code, pt.paid_at, pt.requested_at
    FROM payment_transactions pt
    JOIN point_topup_orders pto ON pto.topup_order_id = pt.topup_order_id
    JOIN point_accounts pa ON pa.point_account_id = pto.point_account_id
    WHERE pt.payment_transaction_id = $1 AND pa.user_id = $2`, [paymentTransactionId, actor.id]);
  if (!result.rowCount) throw new ApiError(404, 'TOP_UP_NOT_FOUND', 'Top-up transaction was not found.');
  const row = result.rows[0];
  return ok(res, {
    id: row.payment_transaction_id,
    topUpOrderId: row.topup_order_id,
    status: row.payment_status,
    points: Number(row.points_amount),
    amountMinor: Number(row.amount),
    currency: row.currency_code,
    paidAt: row.paid_at,
    createdAt: row.requested_at,
  });
}
