import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import Stripe from 'stripe';
import type { Request, Response } from 'express';

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret-that-is-long-enough';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret-that-is-long-enough';
process.env.CSRF_SECRET = 'test-csrf-secret-that-is-long-enough';
process.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_fixture';
const { pool } = await import('../db/database.js');
const { env } = await import('../config/env.js');
const { createCheckoutSession, getCheckoutSession } = await import('./stripe.js');
const sessions = Object.getPrototypeOf(new Stripe('sk_test_fixture').checkout.sessions);
const id = '10000000-0000-4000-8000-000000000001';
const owner = '10000000-0000-4000-8000-000000000002';
const order = '10000000-0000-4000-8000-000000000003';
const row = { payment_transaction_id: id, topup_order_id: order, user_id: owner, amount: '500', currency_code: 'sgd', points_amount: '500', payment_status: 'checkout_created', provider_transaction_id: 'cs_test_fixture' };
const session = { id: 'cs_test_fixture', ui_mode: 'elements', mode: 'payment', livemode: false, status: 'open', amount_total: 500, currency: 'sgd', expires_at: Math.floor(Date.now() / 1000) + 3600, client_secret: 'cs_test_fixture_secret_private', customer_email: 'learner@example.test', metadata: { userId: owner, paymentTransactionId: id, topUpOrderId: order } };
function response() {
  return { locals: { actor: { id: owner, email: 'learner@example.test' } }, status() { return this; }, json(body: unknown) { return body; } } as unknown as Response;
}
const request = () => ({ params: { id } }) as unknown as Request;
afterEach(() => { mock.restoreAll(); env.STRIPE_PUBLISHABLE_KEY = 'pk_test_fixture'; });

test('checkout secret can only be loaded through an owner-scoped lookup', async () => {
  const query = mock.method(pool, 'query', async (sql: string, values: unknown[]) => {
    assert.match(sql, /pt.payment_transaction_id = \$1 AND pa.user_id = \$2/);
    assert.deepEqual(values, [id, owner]);
    return { rows: [], rowCount: 0 };
  });
  const retrieve = mock.method(sessions, 'retrieve', async () => session);
  await assert.rejects(() => getCheckoutSession(request(), response()), { code: 'TOP_UP_NOT_FOUND' });
  assert.equal(query.mock.callCount(), 1);
  assert.equal(retrieve.mock.callCount(), 0);
});

test('open owned checkout returns the same session for refresh without creating another payment', async () => {
  mock.method(pool, 'query', async () => ({ rows: [row], rowCount: 1 }));
  mock.method(sessions, 'retrieve', async (sessionId: string) => { assert.equal(sessionId, session.id); return session; });
  const create = mock.method(sessions, 'create', async () => { throw new Error('must not create'); });
  const result = await getCheckoutSession(request(), response()) as unknown as { data: Record<string, unknown> };
  assert.equal(result.data.clientSecret, session.client_secret);
  assert.equal(result.data.publishableKey, 'pk_test_fixture');
  assert.equal(result.data.amountMinor, 500);
  assert.equal(result.data.points, 500);
  assert.equal(create.mock.callCount(), 0);
});

for (const override of [{ amount_total: 501 }, { livemode: true }, { ui_mode: 'hosted_page' }, { metadata: { ...session.metadata, userId: 'someone-else' } }]) {
  test(`mismatched checkout is rejected: ${Object.keys(override)[0]}`, async () => {
    mock.method(pool, 'query', async () => ({ rows: [row], rowCount: 1 }));
    mock.method(sessions, 'retrieve', async () => ({ ...session, ...override }));
    await assert.rejects(() => getCheckoutSession(request(), response()), { code: 'CHECKOUT_UNAVAILABLE' });
  });
}

test('expired checkout never exposes its secret', async () => {
  mock.method(pool, 'query', async () => ({ rows: [row], rowCount: 1 }));
  mock.method(sessions, 'retrieve', async () => ({ ...session, status: 'expired' }));
  await assert.rejects(() => getCheckoutSession(request(), response()), { code: 'CHECKOUT_EXPIRED' });
});

test('completed checkout returns reconciliation state without a client secret', async () => {
  mock.method(pool, 'query', async () => ({ rows: [row], rowCount: 1 }));
  mock.method(sessions, 'retrieve', async () => ({ ...session, status: 'complete' }));
  const result = await getCheckoutSession(request(), response()) as unknown as { data: unknown };
  assert.deepEqual(result.data, { status: 'complete' });
});

test('missing publishable key fails before creating a top-up order', async () => {
  env.STRIPE_PUBLISHABLE_KEY = '';
  const connect = mock.method(pool, 'connect', async () => { throw new Error('must not create order'); });
  const req = { body: { topUpPackageId: id, uiMode: 'elements' }, get: () => 'checkout-fixture' } as unknown as Request;
  await assert.rejects(() => createCheckoutSession(req, response()), { code: 'STRIPE_NOT_CONFIGURED' });
  assert.equal(connect.mock.callCount(), 0);
});

test('Elements session retains server amounts and metadata, with no hosted URLs or persisted secret', async () => {
  const persisted: unknown[][] = [];
  const client = {
    release() {},
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes('FROM idempotency_records')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM point_topup_packages')) return { rows: [{ point_topup_package_id: id, display_name: '500 points', fiat_amount: '500', currency_code: 'sgd', points_amount: '500' }], rowCount: 1 };
      if (sql.includes('FROM point_accounts')) return { rows: [{ point_account_id: owner }], rowCount: 1 };
      if (sql.includes('FROM payment_channels')) return { rows: [{ payment_channel_id: id }], rowCount: 1 };
      if (sql.includes('INSERT INTO point_topup_orders')) return { rows: [{ topup_order_id: order }], rowCount: 1 };
      if (sql.includes('INSERT INTO payment_transactions')) return { rows: [{ payment_transaction_id: id }], rowCount: 1 };
      if (sql.includes('UPDATE idempotency_records')) persisted.push(values);
      return { rows: [], rowCount: 0 };
    },
  };
  mock.method(pool, 'connect', async () => client);
  const create = mock.method(sessions, 'create', async (params: Stripe.Checkout.SessionCreateParams) => {
    assert.equal(params.ui_mode, 'elements');
    assert.equal(params.success_url, undefined);
    assert.equal(params.cancel_url, undefined);
    assert.match(params.return_url!, new RegExp(`paymentTransactionId=${id}`));
    assert.equal(params.line_items?.[0].price_data?.unit_amount, 500);
    assert.deepEqual(params.payment_method_types, ['card', 'paynow', 'link']);
    assert.equal(params.adaptive_pricing?.enabled, false);
    assert.equal(params.locale, 'zh');
    assert.deepEqual(params.metadata, session.metadata);
    return session;
  });
  const req = { body: { topUpPackageId: id, uiMode: 'elements', locale: 'zh' }, get: () => 'checkout-fixture' } as unknown as Request;
  const result = await createCheckoutSession(req, response()) as unknown as { data: unknown };
  assert.deepEqual(result.data, { paymentTransactionId: id, topUpOrderId: order, status: 'pending' });
  assert.equal(create.mock.callCount(), 1);
  assert.equal(persisted.length, 1);
  assert.doesNotMatch(JSON.stringify(persisted), /client_secret|clientSecret|secret_private/);
});
