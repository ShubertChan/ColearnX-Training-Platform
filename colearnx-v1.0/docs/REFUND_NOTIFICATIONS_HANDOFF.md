# Refund decision popups and administrator users page

After an administrator approves or rejects a refund, the buyer receives a global popup with the purchased item, decision, points and review reason. Online users receive the committed result through an authenticated long poll; offline users fetch unread results immediately after their next authenticated startup. Notices remain in PostgreSQL until the user explicitly confirms/closes the popup or chooses View order. A failed acknowledgement leaves the popup open for retry, and multiple results appear one at a time. Signing out or switching accounts cancels pending requests and removes the previous account's popup.

The administrator Users & Roles list and detail screen now initialize the translation function used by account-status badges. Previously any populated user list could throw `ReferenceError: t is not defined` and render a blank page.

## Deploy

1. Apply `020_refund_decision_notifications.sql` using the controlled owner migration connection and the normal `npm run db:migrate` procedure.
2. Deploy the API, then the frontend. No new environment variables, packages, Stripe changes or seeds are required.
3. Newly reviewed refunds produce notifications. Previously completed reviews are not backfilled. Existing pending requests receive notifications when reviewed after deployment.

The migration only expands the existing table and is compatible with the previous API. If rollback is needed, restore the previous frontend/API release and retain migration 020 and its rows. Do not edit an applied migration or delete unread records.

Each API process uses one additional restricted `DATABASE_URL` connection for PostgreSQL LISTEN; keep one connection available beyond the regular query pool. LISTEN must be supported by the connection/proxy for immediate wakeups. When LISTEN is rejected or unavailable, the API falls back to durable reads after one second. Long polls time out after 20 seconds and use the normal access-token refresh path. Only an opaque user ID is broadcast; notice contents are returned through owner-scoped authenticated queries.

## Verification

- `npm test`, `npm run test:components`, `npm run api:test`, `npm run api:typecheck`, `npm run check:i18n`, `npm run build`.
- `npm run test:e2e -- tests/e2e/refund-notifications.spec.js --project=chromium --workers=1` (also WebKit/Firefox). These browser tests use API-contract fixtures and cover online approval/rejection, persistence before confirmation, offline Chinese mobile delivery and populated administrator navigation.
- `npm run release:database-test` against a **new isolated local PostgreSQL 16 database** named `colearnx_release_check_<suffix>` via `RELEASE_CHECK_DATABASE_URL`. The harness rejects remote/non-test databases. The refund checks use the restricted runtime role and real HTTP endpoints, ledger writes, LISTEN/NOTIFY, owner isolation, duplicate decisions and a deliberately failed notification INSERT to verify full rollback. No live mail, payments or storage calls run.

On staging, keep a buyer signed in while a second browser approves/rejects a refund. Check the popup and wallet, confirm it, and verify it stays dismissed after reload. Repeat while the buyer is signed out, then sign in; the result should appear immediately. Navigate Users & Roles, open a populated account and switch between English and Chinese.

### Local verification, 2026-10-21

- Frontend unit tests: 179 passed; component tests: 89 passed.
- API tests: 299 passed, one existing opt-in test skipped; API typecheck/build passed.
- Deployment tests: 82 passed; production frontend build and Chinese translation checks passed.
- PostgreSQL 16: all 28 release integration groups passed in a new isolated Docker container, including fresh/upgrade migrations through 020, runtime permissions and refund notification checks.
- Chromium: all 76 browser tests passed. The four new refund/admin browser tests also passed in Firefox and WebKit. WebKit uses the test runner's slow-test allowance on Windows.

Browser tests use fixture API responses; PostgreSQL checks exercise the real API and database. No cloud deployment or live payment was performed.
