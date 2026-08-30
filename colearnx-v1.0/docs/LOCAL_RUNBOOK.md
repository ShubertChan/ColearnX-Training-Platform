# Local backend, PostgreSQL and Stripe test runbook

## Start and verify

1. Copy the repository examples to local `.env` files. The root `.env` configures Docker credentials; `apps/api/.env` configures the API. Both are ignored by Git.
2. Start PostgreSQL: `docker compose up -d`.
3. Apply the forward-only schema: `npm run db:migrate`.
4. Seed reference records: `npm run db:seed`.
5. Verify/build: `npm run api:typecheck`, `npm run api:build`, then `npm --prefix apps/api run start`.
6. Check `GET http://localhost:3001/health/ready`.

To establish the first administrator safely, register the intended account, set its exact email in `BOOTSTRAP_ADMIN_EMAIL` in `apps/api/.env`, run `npm run db:seed` once, then remove `BOOTSTRAP_ADMIN_EMAIL`. There is no default admin email or password.

The project database is deliberately mapped to `127.0.0.1:5433` so it does not conflict with another local PostgreSQL service. Docker volumes retain data; do not run destructive database commands against this volume.

## Stripe test mode only

Add test values locally in `apps/api/.env`; do not commit or paste secret values into chat:

```dotenv
STRIPE_MODE=test
STRIPE_CURRENCY=sgd
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Use the Stripe CLI to relay events to `http://localhost:3001/api/v1/payments/stripe/webhook`. The webhook secret printed by the CLI is the value for `STRIPE_WEBHOOK_SECRET`. The initial packages are S$5/10/20/50 for 5/10/20/50 points: S$1 = 1 point, with no promotional bonus. A successful test checkout must change the top-up state to `paid`, credit the user's Available balance, create a balanced ledger transaction, and write a processed Stripe event record.

No live Stripe key is accepted by this MVP. `STRIPE_MODE=test` rejects `sk_live_` credentials and webhook events with `livemode: true`.

## Configuration still required before Stripe testing

1. The actual Stripe test credentials and webhook relay must be configured locally.
2. Register the intended first administrator and run `npm run db:seed` once with `BOOTSTRAP_ADMIN_EMAIL` set, then remove that environment value.
3. The deployment/storage/email-provider owners need to be recorded for the team handoff.

The approved seed configuration creates S$5/10/20/50 top-up packages at a 1:1 SGD-to-point rate and 30/70 revenue policies. Admins can retire packages or activate a later policy without affecting completed orders.

## Current boundaries

- The backend is verified against local Docker PostgreSQL. It does not enable production payment, email delivery, object storage, signed download URLs, virus scanning or hosted-video progress callbacks.
- The React UI is a separate localStorage prototype. Its legacy payment request is not a production-compatible backend client yet.
- Password-reset email delivery and production monitoring/backup retention need their external provider decisions before they can be completed securely.
