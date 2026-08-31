import { ApiError } from '../lib/http.js';

const safeDiagnosticToken = /^[a-zA-Z0-9_.-]{1,100}$/;

export function requireStripeSandboxSecret(secretKey: string) {
  if (!secretKey.startsWith('sk_test_')) {
    throw new ApiError(503, 'STRIPE_NOT_CONFIGURED', 'Stripe test mode is not configured.');
  }
  return secretKey;
}

export function stripeCheckoutError(error: unknown) {
  if (error instanceof ApiError) return error;
  return new ApiError(502, 'STRIPE_CHECKOUT_CREATION_FAILED', 'Unable to create the Stripe checkout session.');
}

function diagnosticToken(value: unknown) {
  return typeof value === 'string' && safeDiagnosticToken.test(value) ? value : undefined;
}

/**
 * Returns a deliberately small allowlist of Stripe diagnostic fields.
 * Never include the original error, message, request body, headers, or raw Stripe response in logs.
 */
export function stripeFailureLogFields(error: unknown) {
  if (!error || typeof error !== 'object') return { kind: 'unknown' as const };
  const candidate = error as {
    type?: unknown;
    code?: unknown;
    decline_code?: unknown;
    statusCode?: unknown;
    requestId?: unknown;
  };
  const statusCode = typeof candidate.statusCode === 'number'
    && Number.isInteger(candidate.statusCode)
    && candidate.statusCode >= 100
    && candidate.statusCode <= 599
    ? candidate.statusCode
    : undefined;
  return {
    kind: 'stripe_api_error' as const,
    type: diagnosticToken(candidate.type),
    code: diagnosticToken(candidate.code),
    declineCode: diagnosticToken(candidate.decline_code),
    statusCode,
    stripeRequestId: diagnosticToken(candidate.requestId),
  };
}
