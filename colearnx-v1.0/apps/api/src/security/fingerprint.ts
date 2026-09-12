import { createHmac } from 'node:crypto';

/**
 * Threat model F-05.  `sha256(ip)` is not de-identification: the IPv4 space is
 * 2^32, so the whole table can be reversed offline in minutes on commodity
 * hardware.  Every low-entropy identifier written to security_events is keyed
 * with a server-held pepper instead.
 *
 * Each input is prefixed with a domain label so that the same pepper cannot
 * produce a colliding digest across two different meanings -- an IP address
 * and a user agent that happened to share a string would otherwise be
 * indistinguishable in the ledger.
 *
 * These functions are deliberately pepper-in, mirroring
 * auth/email-verification.ts, so that they stay unit-testable without loading
 * the environment.
 */
export type FingerprintDomain = 'ip' | 'ua' | 'email';

export function fingerprint(domain: FingerprintDomain, value: string, pepper: string) {
  return createHmac('sha256', pepper).update(`${domain}:${value}`).digest('hex');
}

export function ipFingerprint(ip: string | undefined, pepper: string) {
  return fingerprint('ip', ip && ip.length > 0 ? ip : 'unknown', pepper);
}

export function userAgentFingerprint(userAgent: string | undefined, pepper: string) {
  if (!userAgent) return null;
  // Bound the input before hashing: a multi-kilobyte User-Agent header is
  // either broken or hostile, and hashing it in full wastes work per request.
  return fingerprint('ua', userAgent.slice(0, 500), pepper);
}

/**
 * Lets the ledger answer "how many distinct addresses did this source try"
 * without storing an address that was never a customer's.  Normalisation
 * matches the lookup in auth.ts, which compares on lower(email).
 */
export function emailFingerprint(email: string, pepper: string) {
  return fingerprint('email', email.trim().toLowerCase(), pepper);
}
