# CoLearnX MVP

This directory contains a React/Vite web client and an Express/TypeScript + PostgreSQL backend for the CoLearnX MVP. The backend follows the team ERD and implements the core identity, catalogue review, wallet, order, refund, revenue-policy and Stripe-test paths.

## Run locally

```bash
npm install
docker compose up -d
npm run db:migrate
npm run db:seed
npm run api:typecheck
npm run api:build
npm --prefix apps/api run start
```

Then check `http://localhost:3001/health/ready`. Frontend-only development remains `npm run dev`.

Read [the data model](docs/DATA_MODEL.md), [API contract](docs/API.md) and [local/Stripe runbook](docs/LOCAL_RUNBOOK.md) before connecting the browser client. The backend does not accept client-supplied point amounts or prices for top-ups.

For the deployed staging topology (Cloudflare Pages + Render Express API + Neon PostgreSQL), follow the [Render + Neon staging runbook](docs/STAGING_RENDER_NEON.md). It keeps production-style secrets out of the repository and does not require Docker, Cloudflare Workers, or Hyperdrive.

The API is the source of truth for identity, roles, profile edits, wallet balances, ledger history, top-up packages, catalogue listings, points checkout, orders, refund requests, role applications, drafts/submissions, private course delivery, hosted-video progress, privacy requests and administrator review queues. The server-cart endpoint is a durable draft aid only; it is never an entitlement, price or ledger source of truth.

## Current platform limitations

- Self-arranged Local/Live purchases must be requested at least 72 hours before the scheduled start. Recorded-video/file purchases require server-recorded viewing at or below 10% and no protected-file download; each new order freezes its rule as a policy snapshot.
- Private R2 object storage is deployment-gated. Course and content flows require the object-storage migrations, R2 secrets and bucket CORS before use. Course Cloud is an authorised download, while Local/Live instructions and contact data are buyer-only order snapshots; hosted-video progress is server-clamped and auditable.
- Course and content submissions remain unpublished until an administrator approves them. Publication rejects a draft with required protected files or private Local/Live fulfilment data missing.

## Test

```bash
npm test
npm run api:test
```

`VITE_PAYMENTS_API_ENABLED` is an explicit deployment gate. Leave it `false`
until the Stripe test key and webhook secret are configured in the API
environment; the wallet then disables the top-up entry and explains why. Set
it to `true` and rebuild the Vite client to enable the authenticated,
package-ID-based Stripe sandbox checkout.
