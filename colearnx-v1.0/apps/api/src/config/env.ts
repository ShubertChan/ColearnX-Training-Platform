import 'dotenv/config';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const booleanFromString = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3001),
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  API_ORIGIN: z.string().url().default('http://localhost:3001'),
  DATABASE_URL: z.string().url(),
  DATABASE_SSL: booleanFromString,
  DB_POOL_MAX: z.coerce.number().int().positive().max(50).default(10),
  // Number of proxy hops to trust for the client IP (used by per-IP rate
  // limiting and the security ledger). An explicit, bounded count -- never
  // `true`, which would trust an attacker-supplied X-Forwarded-For. Must equal
  // the real hop count for the deployment (Render = 1); a production guard below
  // rejects 0, which would collapse every client onto the proxy's address.
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),
  ACCESS_TOKEN_SECRET: z.string().min(32),
  REFRESH_TOKEN_SECRET: z.string().min(32),
  CSRF_SECRET: z.string().min(32),
  COOKIE_DOMAIN: z.string().optional().default(''),
  STRIPE_SECRET_KEY: z.string().optional().default(''),
  STRIPE_PUBLISHABLE_KEY: z.string().optional().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().optional().default(''),
  STRIPE_CURRENCY: z.string().regex(/^[a-z]{3}$/).default('sgd'),
  STRIPE_MODE: z.enum(['test', 'live']).default('test'),
  EMAIL_PROVIDER: z.enum(['disabled', 'resend']).default('disabled'),
  RESEND_API_KEY: z.string().trim().optional().default(''),
  EMAIL_FROM: z.string().trim().max(320).optional().default(''),
  EMAIL_VERIFICATION_CODE_PEPPER: z.string().optional().default(''),
  EMAIL_VERIFICATION_CODE_TTL_MINUTES: z.coerce.number().int().min(5).max(30).default(10),
  EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(30).max(3600).default(60),
  PASSWORD_RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(60).default(30),
  EMAIL_VERIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(10).default(5),
  OBJECT_STORAGE_PROVIDER: z.enum(['disabled', 'r2']).default('disabled'),
  R2_ACCOUNT_ID: z.string().trim().optional().default(''),
  R2_ACCESS_KEY_ID: z.string().trim().optional().default(''),
  R2_SECRET_ACCESS_KEY: z.string().trim().optional().default(''),
  R2_BUCKET_NAME: z.string().trim().max(255).optional().default(''),
  R2_REGION: z.string().trim().min(1).max(32).default('auto'),
  R2_SIGNED_UPLOAD_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(600),
  R2_SIGNED_DOWNLOAD_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  CONTENT_UPLOAD_MAX_BYTES: z.coerce.number().int().min(1).max(100 * 1024 * 1024).default(25 * 1024 * 1024),
  CONTENT_VIDEO_UPLOAD_MAX_BYTES: z.coerce.number().int().min(25 * 1024 * 1024).max(100 * 1024 * 1024).default(100 * 1024 * 1024),
  CONTENT_STORAGE_QUOTA_BYTES: z.coerce.number().int().min(100 * 1024 * 1024).max(5 * 1024 * 1024 * 1024).default(500 * 1024 * 1024),
  CONTENT_PENDING_UPLOAD_LIMIT: z.coerce.number().int().min(1).max(10).default(3),
  ENABLE_LOCAL_DELIVERY: booleanFromString,
  ENABLE_HOSTED_VIDEO: booleanFromString,
  VIDEO_SOURCE_MAX_BYTES: z.coerce.number().int().min(5 * 1024 * 1024).max(80 * 1024 * 1024 * 1024).default(20 * 1024 * 1024 * 1024),
  VIDEO_PLAYBACK_GATEWAY_ORIGIN: z.union([z.string().url(), z.literal('')]).optional().default(''),
  VIDEO_PLAYBACK_TOKEN_SECRET: z.string().optional().default(''),
  VIDEO_PLAYBACK_TTL_SECONDS: z.coerce.number().int().min(60).max(300).default(300),
  VIDEO_HEARTBEAT_MAX_GAP_SECONDS: z.coerce.number().int().min(10).max(120).default(30),
  VIDEO_QUEUE_DATABASE_URL: z.union([z.string().url(), z.literal('')]).optional().default(''),
  VIDEO_QUEUE_MIGRATION_DATABASE_URL: z.union([z.string().url(), z.literal('')]).optional().default(''),
  // --- W2 security telemetry ---------------------------------------------
  // Keys every low-entropy identifier written to security_events. A bare
  // SHA-256 of an IPv4 address is exhaustively reversible, so this is what
  // makes the ledger de-identified rather than a stored list of addresses.
  SECURITY_HASH_PEPPER: z.string().optional().default(''),
  SECURITY_ALERT_WEBHOOK_URL: z.union([z.string().url(), z.literal('')]).optional().default(''),
  SECURITY_ALERT_MIN_SEVERITY: z.coerce.number().int().min(0).max(4).default(3),
  SECURITY_EVENT_RETENTION_DAYS: z.coerce.number().int().min(30).max(730).default(180),

  // --- W3 credential protection -------------------------------------------
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(12).max(64).default(12),
  PWNED_PASSWORDS_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  // Overridable so tests can point at a local stub; never derived from a request.
  PWNED_PASSWORDS_API_BASE: z.string().url().default('https://api.pwnedpasswords.com'),
  PWNED_PASSWORDS_TIMEOUT_MS: z.coerce.number().int().min(500).max(10000).default(2500),
  // Per-account cooldown on top of the existing per-IP auth limiter. The
  // limiter bounds one source; this bounds one inbox.
  PASSWORD_RESET_COOLDOWN_SECONDS: z.coerce.number().int().min(30).max(3600).default(60),
  // Failures older than this no longer count toward the lockout ladder, so
  // occasional typos across weeks never accumulate into a lock.
  // At most one lockout notification per account per window. Without a
  // window, an attacker can relock an account repeatedly and use the platform
  // to flood a victim's inbox.
  // --- W4 multi-factor authentication ------------------------------------
  // Encrypts TOTP secrets at rest (AES-256-GCM). A TOTP secret is a bearer
  // credential with nothing to crack, so plaintext storage would mean one
  // database dump defeats two-factor for every enrolled account. Kept out of
  // the database on purpose.
  MFA_SECRET_KEY: z.string().optional().default(''),
  // Signs the two short-lived, purpose-bound challenge tokens. A dedicated
  // secret rather than reusing the access or refresh key: reuse across
  // purposes is finding F-16, and this control depends on purpose separation.
  MFA_CHALLENGE_SECRET: z.string().optional().default(''),
  // How long the second-factor step of sign-in stays open.
  MFA_CONTINUATION_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  // How long one step-up confirmation authorises high-risk actions.
  STEP_UP_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(600),

  LOCK_NOTICE_COOLDOWN_HOURS: z.coerce.number().int().min(1).max(168).default(6),
  LOGIN_FAILURE_DECAY_HOURS: z.coerce.number().int().min(1).max(168).default(12),

  // --- W5 distributed controls --------------------------------------------
  // When set, rate limiting (lib/redis.ts + security/rate-limit-store.ts) and
  // security-alert dedup (security/alerts.ts) use Redis, so both are correct
  // across more than one API instance. Empty = single-instance in-process
  // behaviour, which is the default and unchanged from before W5.
  REDIS_URL: z.union([z.string().url(), z.literal('')]).optional().default(''),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
}

if (parsed.data.STRIPE_MODE === 'test' && parsed.data.STRIPE_SECRET_KEY.startsWith('sk_live_')) {
  throw new Error('STRIPE_MODE=test rejects live Stripe secret keys.');
}
if (parsed.data.NODE_ENV === 'production' && parsed.data.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
  throw new Error('Production must not use a Stripe test secret key.');
}
if (parsed.data.NODE_ENV !== 'development' && parsed.data.EMAIL_PROVIDER === 'disabled') {
  throw new Error('Staging and production require EMAIL_PROVIDER=resend for email verification.');
}
if (parsed.data.EMAIL_PROVIDER === 'resend') {
  if (!parsed.data.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER=resend.');
  if (!parsed.data.EMAIL_FROM) throw new Error('EMAIL_FROM is required when EMAIL_PROVIDER=resend.');
  if (parsed.data.EMAIL_VERIFICATION_CODE_PEPPER.length < 32) {
    throw new Error('EMAIL_VERIFICATION_CODE_PEPPER must be at least 32 characters when EMAIL_PROVIDER=resend.');
  }
}

if (parsed.data.OBJECT_STORAGE_PROVIDER === 'r2') {
  if (!parsed.data.R2_ACCOUNT_ID) throw new Error('R2_ACCOUNT_ID is required when OBJECT_STORAGE_PROVIDER=r2.');
  if (!parsed.data.R2_ACCESS_KEY_ID) throw new Error('R2_ACCESS_KEY_ID is required when OBJECT_STORAGE_PROVIDER=r2.');
  if (!parsed.data.R2_SECRET_ACCESS_KEY) throw new Error('R2_SECRET_ACCESS_KEY is required when OBJECT_STORAGE_PROVIDER=r2.');
  if (!parsed.data.R2_BUCKET_NAME) throw new Error('R2_BUCKET_NAME is required when OBJECT_STORAGE_PROVIDER=r2.');
}
if (parsed.data.ENABLE_HOSTED_VIDEO) {
  if (!parsed.data.VIDEO_PLAYBACK_GATEWAY_ORIGIN) throw new Error('VIDEO_PLAYBACK_GATEWAY_ORIGIN is required when ENABLE_HOSTED_VIDEO=true.');
  if (parsed.data.VIDEO_PLAYBACK_TOKEN_SECRET.length < 32) throw new Error('VIDEO_PLAYBACK_TOKEN_SECRET must be at least 32 characters when ENABLE_HOSTED_VIDEO=true.');
}
// The pepper separates a de-identified ledger from a stored list of IP
// addresses, so a real deployment must supply one. Anywhere else -- local
// development, `NODE_ENV=test`, a CI runner -- it is derived from an existing
// secret rather than demanded.
//
// The first version of this required an explicit value for every NODE_ENV
// except 'development', which broke three existing test files that set
// NODE_ENV='test'. Requiring a new variable in order to run the unit suite is
// the wrong trade: it buys no security (a test pepper protects nothing) and
// costs every contributor a setup step they will eventually skip by weakening
// the check. Deriving is strictly better, provided it never happens in
// staging or production -- which the condition below enforces.
// Same rule as SECURITY_HASH_PEPPER: a real deployment must supply these;
// anywhere else -- local development, NODE_ENV=test, a CI runner -- they are
// derived from an existing secret.
//
// The first version of this made both unconditionally required, which broke
// six existing test files that load env.ts without them. That is the identical
// mistake made with SECURITY_HASH_PEPPER a week earlier: demanding a new
// variable to run the unit suite buys no security (a test key protects
// nothing) and costs every contributor a setup step they will eventually skip
// by weakening the check.
const deployedEnvironment = parsed.data.NODE_ENV === 'production' || parsed.data.NODE_ENV === 'staging';

for (const name of ['MFA_SECRET_KEY', 'MFA_CHALLENGE_SECRET'] as const) {
  if (!parsed.data[name]) {
    if (deployedEnvironment) {
      throw new Error(`${name} is required in staging and production.`);
    }
    // Distinct domain labels, so the two derived values are never equal and
    // the separation the check below enforces still holds locally.
    parsed.data[name] = createHash('sha256')
      .update(`colearnx-local-${name.toLowerCase()}:${parsed.data.ACCESS_TOKEN_SECRET}`)
      .digest('hex');
  } else if (parsed.data[name].length < 32) {
    throw new Error(`${name} must be at least 32 characters.`);
  }
}

if (parsed.data.MFA_SECRET_KEY === parsed.data.MFA_CHALLENGE_SECRET) {
  // Two keys with different jobs. Sharing one would make an encryption-key
  // rotation silently invalidate every outstanding challenge token, and vice
  // versa -- the coupling nobody discovers until a rotation goes wrong.
  throw new Error('MFA_SECRET_KEY and MFA_CHALLENGE_SECRET must be different values.');
}

if (!parsed.data.SECURITY_HASH_PEPPER) {
  if (parsed.data.NODE_ENV === 'production' || parsed.data.NODE_ENV === 'staging') {
    throw new Error('SECURITY_HASH_PEPPER is required in staging and production.');
  }
  // Derived, not empty: an empty HMAC key silently reduces the fingerprints to
  // unkeyed digests, which is the exact weakness this replaced.
  parsed.data.SECURITY_HASH_PEPPER = createHash('sha256')
    .update(`colearnx-local-security-pepper:${parsed.data.ACCESS_TOKEN_SECRET}`)
    .digest('hex');
} else if (parsed.data.SECURITY_HASH_PEPPER.length < 32) {
  throw new Error('SECURITY_HASH_PEPPER must be at least 32 characters.');
}

// Fail closed on a misconfiguration that would otherwise look like a working
// alert channel while delivering nothing.
if (parsed.data.NODE_ENV === 'production' && !parsed.data.SECURITY_ALERT_WEBHOOK_URL) {
  throw new Error('SECURITY_ALERT_WEBHOOK_URL is required in production: high-severity events must reach an operator.');
}

// F-14: in a deployed environment the client IP must come from the proxy, not
// the socket. TRUST_PROXY=0 there would make every request appear to originate
// from the load balancer, collapsing per-IP rate limiting and the security
// ledger's source attribution onto one address. Fail closed on that misconfig.
if (deployedEnvironment && parsed.data.TRUST_PROXY === 0) {
  throw new Error('TRUST_PROXY must be the real proxy hop count (>= 1) in staging and production.');
}

export const env = parsed.data;
