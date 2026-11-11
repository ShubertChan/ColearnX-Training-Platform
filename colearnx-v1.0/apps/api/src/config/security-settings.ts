import { createHash } from 'node:crypto';

const localLabels = {
  MFA_SECRET_KEY: 'mfa_secret_key',
  MFA_CHALLENGE_SECRET: 'mfa_challenge_secret',
  SECURITY_HASH_PEPPER: 'security-pepper',
} as const;

export function resolveSecuritySecret(name: keyof typeof localLabels, value: string, seed: string, deployed: boolean): string {
  if (value) {
    if (value.length < 32) throw new Error(`${name} must be at least 32 characters.`);
    return value;
  }
  if (deployed) throw new Error(`${name} is required in staging and production.`);
  // Preserve the domains already used by existing development fingerprints and MFA records.
  return createHash('sha256').update(`colearnx-local-${localLabels[name]}:${seed}`).digest('hex');
}

export function checkProxyTopology(deployed: boolean, configured: string | undefined, hops: number, apiOrigin: string): void {
  if (!deployed) return;
  if (!configured?.trim() || hops < 1) throw new Error('Set TRUST_PROXY explicitly to the deployed proxy hop count.');
  // This staging service is reachable through Render's direct public ingress.
  // Trusting a second forwarded address would also trust a client-supplied prefix on that shorter path.
  if (new URL(apiOrigin).hostname === 'api-staging.colearnx.net' && hops !== 1) {
    throw new Error('The CoLearnX staging Render ingress requires TRUST_PROXY=1.');
  }
}
