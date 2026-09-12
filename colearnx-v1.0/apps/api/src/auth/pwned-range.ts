import { createHash } from 'node:crypto';
import { normalisePassword } from './password-policy.js';

/**
 * The pure half of the breached-password check: digest splitting and response
 * parsing. Isolated from the fetch so both can be tested without a network.
 *
 * SHA-1 appears here because it is the corpus's index, not because it is a
 * suitable password hash. Storage remains argon2id. No security claim is made
 * on SHA-1: it is an opaque lookup key.
 */
export function rangeParts(password: string) {
  const digest = createHash('sha1').update(normalisePassword(password), 'utf8').digest('hex').toUpperCase();
  return { prefix: digest.slice(0, 5), suffix: digest.slice(5) };
}

/**
 * Parses a range response into the count for our suffix.
 *
 * The body is `SUFFIX:COUNT` per line with CRLF endings. When `Add-Padding` is
 * requested the response also carries synthetic entries whose count is 0;
 * those parse to 0 naturally and need no special case.
 */
export function countForSuffix(body: string, suffix: string): number {
  for (const line of body.split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    if (line.slice(0, separator).trim().toUpperCase() !== suffix.toUpperCase()) continue;
    const count = Number.parseInt(line.slice(separator + 1).trim(), 10);
    return Number.isFinite(count) ? count : 0;
  }
  return 0;
}
