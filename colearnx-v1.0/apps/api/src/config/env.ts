import 'dotenv/config';
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
  EMAIL_VERIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(10).default(5),
  OBJECT_STORAGE_PROVIDER: z.enum(['disabled', 'r2']).default('disabled'),
  R2_ACCOUNT_ID: z.string().trim().optional().default(''),
  R2_ACCESS_KEY_ID: z.string().trim().optional().default(''),
  R2_SECRET_ACCESS_KEY: z.string().trim().optional().default(''),
  R2_BUCKET_NAME: z.string().trim().max(255).optional().default(''),
  R2_REGION: z.string().trim().min(1).max(32).default('auto'),
  R2_SIGNED_UPLOAD_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(600),
  R2_SIGNED_DOWNLOAD_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  CONTENT_UPLOAD_MAX_BYTES: z.coerce.number().int().min(1).max(104857600).default(104857600),
  ENABLE_LOCAL_DELIVERY: booleanFromString,
  ENABLE_HOSTED_VIDEO: booleanFromString,
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
export const env = parsed.data;
