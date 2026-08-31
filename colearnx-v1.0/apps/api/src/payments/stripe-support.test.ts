import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../lib/http.js';
import { requireStripeSandboxSecret, stripeCheckoutError, stripeFailureLogFields } from './stripe-support.js';

test('Stripe sandbox configuration rejects a missing or live secret as not configured', () => {
  for (const secret of ['', 'sk_live_do-not-use']) {
    assert.throws(
      () => requireStripeSandboxSecret(secret),
      (error: unknown) => error instanceof ApiError
        && error.status === 503
        && error.code === 'STRIPE_NOT_CONFIGURED',
    );
  }
});

test('Stripe sandbox configuration accepts a test secret', () => {
  assert.equal(requireStripeSandboxSecret('sk_test_example'), 'sk_test_example');
});

test('checkout error mapping preserves an existing configuration ApiError', () => {
  const configurationError = new ApiError(503, 'STRIPE_NOT_CONFIGURED', 'Stripe test mode is not configured.');
  assert.equal(stripeCheckoutError(configurationError), configurationError);
});

test('checkout error mapping hides the Stripe SDK failure behind a stable API error', () => {
  const mapped = stripeCheckoutError(new Error('request failed with sk_test_sensitive'));
  assert.equal(mapped.status, 502);
  assert.equal(mapped.code, 'STRIPE_CHECKOUT_CREATION_FAILED');
  assert.equal(mapped.message, 'Unable to create the Stripe checkout session.');
  assert.doesNotMatch(mapped.message, /sensitive/);
});

test('Stripe failure logging only returns allowlisted non-secret diagnostics', () => {
  const fields = stripeFailureLogFields({
    type: 'StripeInvalidRequestError',
    code: 'parameter_invalid_integer',
    decline_code: 'do_not_honor',
    statusCode: 400,
    requestId: 'req_example123',
    message: 'contains sk_test_sensitive',
    raw: { headers: { authorization: 'Bearer secret' } },
  });
  assert.deepEqual(fields, {
    kind: 'stripe_api_error',
    type: 'StripeInvalidRequestError',
    code: 'parameter_invalid_integer',
    declineCode: 'do_not_honor',
    statusCode: 400,
    stripeRequestId: 'req_example123',
  });
  assert.doesNotMatch(JSON.stringify(fields), /sensitive|authorization|Bearer|secret/);
});
