# Render + Neon staging runbook

## Scope and public addresses

This runbook deploys the existing Express API to Render and the React/Vite client to Cloudflare Pages. It does not use Cloudflare Workers or Hyperdrive.

- Pages origin: `https://colearnx-staging.pages.dev`
- API origin: `https://colearnx-api-staging.onrender.com`
- Frontend API base URL: `https://colearnx-api-staging.onrender.com/api/v1`

## Render API service

Use Node.js 22.x with the repository root set to `colearnx-v1.0`.

```text
Build: npm --prefix apps/api ci --include=dev && npm --prefix apps/api run build
Start: npm --prefix apps/api start
Health check: /health/ready
```

Set these variables directly in Render's secure Environment editor. Never commit or upload a real `.env` file, and never send values through GitHub, chat, screenshots, or pull requests:

```text
NODE_ENV=staging
APP_ORIGIN=https://colearnx-staging.pages.dev
API_ORIGIN=https://colearnx-api-staging.onrender.com
DATABASE_URL=<restricted colearnx_app Neon connection string>
DATABASE_SSL=true
DB_POOL_MAX=5
TRUST_PROXY=1
ACCESS_TOKEN_SECRET=<unique random secret, at least 32 characters>
REFRESH_TOKEN_SECRET=<different unique random secret, at least 32 characters>
CSRF_SECRET=<different unique random secret, at least 32 characters>
COOKIE_DOMAIN=
OBJECT_STORAGE_PROVIDER=r2
R2_ACCOUNT_ID=<Cloudflare account ID>
R2_ACCESS_KEY_ID=<R2 bucket-scoped API token access-key ID>
R2_SECRET_ACCESS_KEY=<R2 bucket-scoped API token secret>
R2_BUCKET_NAME=<private staging R2 bucket name>
R2_REGION=auto
R2_SIGNED_UPLOAD_TTL_SECONDS=600
R2_SIGNED_DOWNLOAD_TTL_SECONDS=300
CONTENT_UPLOAD_MAX_BYTES=26214400
CONTENT_VIDEO_UPLOAD_MAX_BYTES=104857600
CONTENT_STORAGE_QUOTA_BYTES=524288000
CONTENT_PENDING_UPLOAD_LIMIT=3

ENABLE_LOCAL_DELIVERY=false
ENABLE_HOSTED_VIDEO=false
LOG_LEVEL=info
EMAIL_PROVIDER=resend
RESEND_API_KEY=<Resend API key>
EMAIL_FROM=CoLearnX <no-reply@your-verified-domain.example>
EMAIL_VERIFICATION_CODE_PEPPER=<separate random value of at least 32 characters>
EMAIL_VERIFICATION_CODE_TTL_MINUTES=10
EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS=60
EMAIL_VERIFICATION_MAX_ATTEMPTS=5
```

`PORT` is injected by Render and must not be set. `BOOTSTRAP_ADMIN_EMAIL` is temporary and is set only while running the one-time seed. Keep the `STRIPE_*` variables blank for the initial smoke test; add Stripe **test** keys and the webhook secret only in the Render Environment editor when separately validating payments.

The long-running service must use only `DATABASE_URL` for the restricted `colearnx_app` role. Set `DATABASE_SSL=true`, `DB_POOL_MAX=5`, and `TRUST_PROXY=1`. Render provides the actual `PORT` at runtime. `APP_ORIGIN` must exactly match the Pages URL and `API_ORIGIN` must exactly match the public Render URL.

The refresh cookie is `HttpOnly`, `Secure`, and `SameSite=None` in staging so the Pages application can call the Render API with credentials. Keep `COOKIE_DOMAIN` blank because Pages and Render do not share a parent domain. The browser first calls `GET /api/v1/auth/csrf`, then sends the returned `X-CSRF-Token` header for refresh and logout requests.

## Cloudflare R2 private bucket

Create one private staging bucket; do not expose a public R2/custom-domain URL. Create a bucket-scoped R2 API token that can read, write, and delete objects **only** in that bucket. Put the account ID, access-key ID, token secret and bucket name into Render's secure environment editor as the `R2_*` variables above. Never place any R2 value in the Pages build variables or a GitHub secret file.

The bucket CORS rule must allow the exact deployed web origin, methods `PUT`, `GET`, and `HEAD`, and request header `Content-Type`. Do not use `*` for production origins. The backend supplies the short-lived signed URLs and verifies every completed upload using `HeadObject`; it does not proxy file bytes through Render. Schedule `npm --prefix apps/api run storage:reconcile` every 15 minutes with the same restricted API/R2 credentials to remove expired orphaned objects and retry `delete_pending` records.

## Cloudflare Pages

Set these build variables in the Pages project, then trigger a new deployment:

```text
VITE_API_BASE_URL=https://colearnx-api-staging.onrender.com/api/v1
VITE_PAYMENTS_API_ENABLED=false
VITE_PAYMENT_PROVIDER=stripe
```

`VITE_*` values are embedded at Vite build time. Editing a variable without rebuilding does not change the already published site.

Keep `VITE_PAYMENTS_API_ENABLED=false` until the Render API has a Stripe test
secret and matching webhook signing secret. While it is false, the wallet keeps
balances and transaction history available but disables the top-up entry. Once
the API integration is ready, set the value to `true` and rebuild/redeploy
Pages to expose the sandbox checkout.

## Neon migration and seed

PostgreSQL 16 is supported by the current schema and migrations. `001_initial_schema.sql` and `002_commerce_hardening.sql` are immutable once recorded in `schema_migrations`; all later changes must be new, forward-only migration files. Before applying pending `005_object_storage.sql` through `007_storage_quota_index.sql`, create a Neon branch or restore-point snapshot. These migrations are additive: they create storage metadata, account-deletion controls and a quota index; they do not copy, delete, or overwrite account/order/file data.

For the current staging database, run migrations with a controlled Neon Owner direct/unpooled connection. The separate `colearnx_migrator` role must not be used for DDL until it has explicit `CREATE` and object-ownership privileges. The migration command only requires these variables:

```text
MIGRATION_DATABASE_URL=<controlled direct/unpooled Neon URL>
DATABASE_SSL=true
```

Run from `colearnx-v1.0` in the controlled deployment environment:

```text
npm run db:migrate
```

The command records a SHA-256 checksum and safely skips a previously applied file with the same contents. Never edit an applied migration.

After migration, run the idempotent seed through the restricted runtime account:

```text
DATABASE_URL=<colearnx_app Render secret> DATABASE_SSL=true npm run db:seed
```

Use the host's secure environment editor rather than placing the value into a command history when possible.

## First staging administrator

1. Register a new staging account normally; it receives only the `member` role.
2. Temporarily set `BOOTSTRAP_ADMIN_EMAIL` to that registered email in the controlled seed environment.
3. Run `npm run db:seed` once.
4. Remove `BOOTSTRAP_ADMIN_EMAIL` immediately and restart/redeploy if it was set on a service.

No local account, database superuser, password hash, Stripe event, ledger entry, or Docker volume is migrated to staging.

## Required smoke test

1. `GET /health/live` returns HTTP 200.
2. `GET /health/ready` returns HTTP 200 and performs `SELECT 1` through `colearnx_app`.
3. Register, login, reload/open a new tab, then logout from the Pages site.
4. Confirm ordinary users receive HTTP 403 for `/api/v1/admin/*`.
5. Bootstrap one staging administrator and verify user review, role decisions, suspend, and reinstate actions.

Keep Stripe test variables blank for this smoke test. Add Stripe test keys and a public webhook only in a separate payment-validation change.
