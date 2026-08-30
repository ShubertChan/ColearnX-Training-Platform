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

Set the variable names from `apps/api/.env.staging.example` in Render. Do not upload that file or send values through GitHub, chat, screenshots, or pull requests.

The long-running service must use only `DATABASE_URL` for the restricted `colearnx_app` role. Set `DATABASE_SSL=true`, `DB_POOL_MAX=5`, and `TRUST_PROXY=1`. Render provides the actual `PORT` at runtime. `APP_ORIGIN` must exactly match the Pages URL and `API_ORIGIN` must exactly match the public Render URL.

The refresh cookie is `HttpOnly`, `Secure`, and `SameSite=None` in staging so the Pages application can call the Render API with credentials. Keep `COOKIE_DOMAIN` blank because Pages and Render do not share a parent domain. The browser first calls `GET /api/v1/auth/csrf`, then sends the returned `X-CSRF-Token` header for refresh and logout requests.

## Cloudflare Pages

Set these build variables in the Pages project, then trigger a new deployment:

```text
VITE_API_BASE_URL=https://colearnx-api-staging.onrender.com/api/v1
VITE_PAYMENTS_API_ENABLED=false
VITE_PAYMENT_PROVIDER=stripe
```

`VITE_*` values are embedded at Vite build time. Editing a variable without rebuilding does not change the already published site.

## Neon migration and seed

PostgreSQL 16 is supported by the current schema and migrations. `001_initial_schema.sql` and `002_commerce_hardening.sql` are immutable once recorded in `schema_migrations`; all later changes must be new, forward-only migration files.

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
