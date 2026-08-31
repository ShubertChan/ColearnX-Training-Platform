# Backend and database release handoff

Use this checklist for every backend, database-permission, or Stripe change. It is intentionally separate from the one-time environment setup guide.

## Developer: what to commit and describe

1. Work on a feature branch and open a pull request against `main`.
2. A schema or permission-boundary change must add a new forward-only file under `db/migrations/`, for example `003_add_course_visibility.sql`. Never edit a migration already present in `schema_migrations`; the migrator verifies its SHA-256 checksum.
3. Put all required `GRANT` and `REVOKE` statements in that same new migration. The long-running API must continue to use the restricted `colearnx_app` role. It must not use the owner/migration connection string.
4. Commit the matching API source, tests, API/data-model documentation, and lockfiles when dependencies changed. Commit an `.env.example` update only when a variable name or non-secret default changes; never commit an actual `.env`, credentials, Stripe secrets, Docker volumes, or database dumps.
5. In the pull-request description state: the release commit; migration filenames; whether the change is backward compatible; required/removed environment-variable names; deploy order; Stripe webhook changes; smoke tests; and the safe rollback or recovery action.

For a breaking database change, use expand -> migrate -> backfill -> deploy code -> contract in separate releases. Do not drop or rename a live field in the same deployment that first switches the API to its replacement.

## Deployment owner: after the PR is merged

1. Check out the approved commit and run `git pull --ff-only`.
2. If a lockfile changed, run `npm ci` and `npm --prefix apps/api ci`. Then run `npm run api:typecheck`, `npm run api:test`, `npm test`, `npm run api:build`, and `npm run build`.
3. Create or change real values only in Render, Neon, Cloudflare, and Stripe's secure dashboards. Do not create a committed `.env` file. The running API gets only `DATABASE_URL` for `colearnx_app`; keep `MIGRATION_DATABASE_URL` out of the long-running service.
4. In the controlled migration environment, run `npm run db:migrate` once with `MIGRATION_DATABASE_URL`. Run `npm run db:seed` only when the release explicitly requires its idempotent seed data.
5. Deploy the API. For compatible changes, deploy the frontend afterward. For an expand/contract change, preserve compatibility until all callers have moved.
6. Verify `/health/live`, `/health/ready`, affected APIs, role boundaries, and the documented smoke tests. Do not run `docker compose down -v` on an environment that holds data.

## Stripe changes

Keep `STRIPE_MODE=test` for this MVP. Store `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, and `STRIPE_WEBHOOK_SECRET` only in the API host's secure environment. When changing payment code, update the Stripe Dashboard webhook endpoint to `<API_ORIGIN>/api/v1/payments/stripe/webhook`, deploy first, then send a Stripe test event and confirm the resulting top-up, ledger entries, and stored event are correct. Never put a Stripe secret in a pull request, issue, chat, or screenshot.
