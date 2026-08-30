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

export const env = parsed.data;
