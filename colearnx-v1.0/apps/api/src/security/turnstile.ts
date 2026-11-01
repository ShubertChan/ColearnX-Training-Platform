import { ApiError } from '../lib/http.js';

export type HumanAction = 'login' | 'register' | 'forgot_password';

export function checkTurnstileSettings(siteKey: string, secret: string, deployed: boolean) {
  if (Boolean(siteKey) !== Boolean(secret)) throw new Error('Configure both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY, or neither.');
  if (deployed && [siteKey, secret].some(key => /^[123]x0{10,}/.test(key))) {
    throw new Error('Turnstile test keys cannot be used in staging or production.');
  }
}

const rejected = () => new ApiError(403, 'HUMAN_CHECK_REQUIRED', 'Complete a new human verification and try again.');
const unavailable = () => new ApiError(503, 'HUMAN_CHECK_UNAVAILABLE', 'Human verification is unavailable. Please try again.');

// The provider enforces expiration and single use; our API binds that proof to the
// intended form and frontend hostname. Never accept a verification URL from a client.
export async function verifyHumanToken(raw: unknown, action: HumanAction, secret: string, hostname: string, send = fetch) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) throw rejected();
  let verdict;
  try {
    const response = await send('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body: new URLSearchParams({ secret, response: raw }),
      signal: AbortSignal.timeout(4000), redirect: 'error',
    });
    if (!response.ok) throw unavailable();
    verdict = await response.json();
  } catch { throw unavailable(); }
  if (!verdict || typeof verdict.success !== 'boolean') throw unavailable();
  if (verdict.success === false && Array.isArray(verdict['error-codes']) &&
    verdict['error-codes'].some((code: unknown) => ['internal-error', 'invalid-input-secret', 'missing-input-secret'].includes(String(code)))) throw unavailable();
  if (verdict.success !== true || verdict.action !== action || verdict.hostname !== hostname) throw rejected();
}
