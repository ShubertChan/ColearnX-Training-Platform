import { env } from '../config/env.js';
import { countForSuffix, rangeParts } from './pwned-range.js';

export { countForSuffix, rangeParts } from './pwned-range.js';

/**
 * Breached-credential check against the Have I Been Pwned range API
 * (ASVS 2.1.7, threat model F-04).
 *
 * PRIVACY PROPERTY -- this is the part that has to be right.  The password is
 * never transmitted, and neither is its full hash.  Only the first five hex
 * characters of the SHA-1 digest leave the process.  That prefix selects a
 * bucket of roughly 800 candidate hashes, which the server returns in full;
 * the comparison against our own suffix happens locally.  The service
 * therefore learns which of ~1.05 million buckets was queried and nothing
 * else, and cannot distinguish our password from the ~800 others sharing the
 * prefix.
 *
 * SHA-1 is used because that is the corpus's index, not because it is a
 * suitable password hash.  Storage remains argon2id.  There is no security
 * claim being made on SHA-1 here: it is an opaque lookup key.
 *
 * FAILURE MODE -- this check FAILS OPEN.  If the API is slow, rate-limited or
 * unreachable, the password is accepted and an `auth.breach_check_unavailable`
 * event is recorded at medium severity.  Rationale: failing closed would let a
 * third party's outage block all registrations and all password resets, which
 * is a larger and more likely harm than the marginal one of admitting a
 * breached password during that window.  The event exists so that a sustained
 * outage is visible rather than silent -- an unmonitored fail-open control is
 * indistinguishable from no control at all.
 */

export type BreachCheck =
  | { status: 'checked'; count: number }
  | { status: 'unavailable'; reason: 'disabled' | 'timeout' | 'http_error' | 'network_error' };

export async function breachCount(password: string): Promise<BreachCheck> {
  if (!env.PWNED_PASSWORDS_ENABLED) return { status: 'unavailable', reason: 'disabled' };
  const { prefix, suffix } = rangeParts(password);

  let response: Response;
  try {
    response = await fetch(`${env.PWNED_PASSWORDS_API_BASE}/range/${prefix}`, {
      headers: {
        // Asks the service to pad every response to a uniform size. Without
        // it, an observer of the encrypted connection can infer the bucket
        // from the response length, which partially undoes k-anonymity.
        'Add-Padding': 'true',
        // The API requires a descriptive user agent and rejects requests
        // without one.
        'User-Agent': 'CoLearnX-Security/1.0',
      },
      signal: AbortSignal.timeout(env.PWNED_PASSWORDS_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return { status: 'unavailable', reason: timedOut ? 'timeout' : 'network_error' };
  }

  if (!response.ok) return { status: 'unavailable', reason: 'http_error' };
  try {
    return { status: 'checked', count: countForSuffix(await response.text(), suffix) };
  } catch {
    return { status: 'unavailable', reason: 'network_error' };
  }
}
