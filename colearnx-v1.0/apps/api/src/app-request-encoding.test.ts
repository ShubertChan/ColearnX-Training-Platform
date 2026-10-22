import assert from 'node:assert/strict';
import test from 'node:test';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import request from 'supertest';
import Stripe from 'stripe';

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret-that-is-long-enough';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret-that-is-long-enough';
process.env.CSRF_SECRET = 'test-csrf-secret-that-is-long-enough';
process.env.STRIPE_SECRET_KEY = 'sk_test_encoding_regression_fixture';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_encoding_regression_fixture';
const { createApp } = await import('./app.js');

// Ordinary compressed fixtures only: no exploit payloads or external services.
for (const [encoding, compress] of [
  ['br', brotliCompressSync], ['gzip', gzipSync], ['deflate', deflateSync],
] as const) {
  for (const [name, path, type, body] of [
    ['JSON', '/api/v1/reports', 'application/json', '{}'],
    ['form', '/api/v1/reports', 'application/x-www-form-urlencoded', 'reason=test'],
    ['webhook', '/api/v1/payments/stripe/webhook', 'application/json', '{}'],
  ]) {
    test(`${name} rejects ${encoding} before authentication or webhook verification`, async () => {
      const response = await request(createApp()).post(path)
        .set('Content-Type', type).set('Content-Encoding', encoding)
        .send(compress(Buffer.from(body)));
      assert.equal(response.status, 415);
      assert.equal(response.body.error.code, 'UNSUPPORTED_CONTENT_ENCODING');
      assert.deepEqual(response.body.error.details, {});
    });
  }
}

test('unknown content encodings are rejected with a client error', async () => {
  const response = await request(createApp()).post('/api/v1/reports')
    .set('Content-Type', 'application/json').set('Content-Encoding', 'unknown').send('{}');
  assert.equal(response.status, 415);
  assert.equal(response.body.error.code, 'UNSUPPORTED_CONTENT_ENCODING');
});

test('ordinary JSON and form requests still reach authentication', async () => {
  for (const encoding of [undefined, 'identity']) {
    for (const [type, body] of [['application/json', '{}'], ['application/x-www-form-urlencoded', 'reason=test']]) {
      const pending = request(createApp()).post('/api/v1/reports').set('Content-Type', type);
      if (encoding) pending.set('Content-Encoding', encoding);
      const response = await pending.send(body);
      assert.equal(response.status, 401);
      assert.equal(response.body.error.code, 'AUTH_REQUIRED');
    }
  }
});

test('uncompressed Stripe webhook preserves exact bytes for signature verification', async () => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  // A live-mode fixture is deliberately rejected AFTER successful verification,
  // so the test cannot reach a database or create a payment.
  const payload = '{ "id": "evt_encoding_fixture", "livemode": true, "type": "test.fixture", "data": { "object": {} } }';
  const signature = stripe.webhooks.generateTestHeaderString({
    payload, secret: process.env.STRIPE_WEBHOOK_SECRET!,
  });
  const send = (body: string) => request(createApp()).post('/api/v1/payments/stripe/webhook')
    .set('Content-Type', 'application/json').set('stripe-signature', signature).send(body);
  const valid = await send(payload);
  assert.equal(valid.status, 400);
  assert.equal(valid.body.error.code, 'STRIPE_LIVEMODE_REJECTED');
  const altered = await send(JSON.stringify(JSON.parse(payload)));
  assert.equal(altered.status, 400);
  assert.equal(altered.body.error.code, 'STRIPE_SIGNATURE_INVALID');
});
