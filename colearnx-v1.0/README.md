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

The current web client uses the API as the source of truth for identity, roles, profile edits, wallet balances, ledger history, top-up packages, catalogue listings, points checkout, orders, refund requests, role applications, creator drafts/submissions and administrator review queues. The cart is only an in-memory selection before checkout; it is not an order or entitlement record.

## Current platform limitations

- Cloud purchases are refundable only within 72 hours and at or below 10% recorded progress; Live, Local and Record rules are enforced by the API from the purchase-time snapshot.
- Private object storage, confirmed Local-download evidence, hosted-video progress capture, public creator profiles, Google OAuth and password-reset email are not yet configured. The web client does not claim these actions succeeded and does not expose a simulated player, download or reset confirmation.
- Course and content submissions remain unpublished until an administrator approves them. Content metadata can be submitted, but paid-file delivery must wait for the private storage adapter.

## Test

```bash
npm test
npm run api:test
```

Keep `VITE_PAYMENTS_API_ENABLED` off until the frontend owner adopts the documented authentication and package-ID top-up API. The existing demo payment request is intentionally not accepted by the backend.
