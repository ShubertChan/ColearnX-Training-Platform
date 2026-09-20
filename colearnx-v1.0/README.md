# CoLearnX training platform

This repository contains the React/Vite frontend, the Express/Node API in `apps/api`, PostgreSQL migrations, and the hosted-video worker and media gateway source. Cloud databases and external mail/storage/payment services are configured separately; credentials are not included. The browser expects a compatible API at `/api/v1`; during Vite development that path is proxied to `http://localhost:3001`.

## Run locally

Open a terminal in the directory that contains this `package.json`, then run:

```powershell
npm.cmd install
npm.cmd run dev
```

Open the URL printed by Vite (normally `http://localhost:5173`). Public course/resource browsing can render without a session, but sign-in, wallets, checkout, protected downloads and account workflows require the API.

To point at a separately running backend, copy `.env.example` to `.env.local` and set `VITE_API_BASE_URL`. Do not put database, R2, email or payment secrets in a `VITE_` variable.

## Product rules represented in this UI

- Cloud course delivery is a purchase-authorised file download.
- Local and Live delivery are arranged by the Trainer and learner. Buyer-only instructions, contact details and optional meeting/group links are shown after purchase; CoLearnX does not organise the later meeting or attendance.
- Delivery channel and progress tracking are separate. Only a product explicitly marked as online video uses server-recorded `watchedSeconds / totalDurationSeconds`; its viewing-progress refund condition is met at 10% or less.
- Checkout uses a final order confirmation, mixed course/resource items and an idempotent server mutation. A successful order is preserved even if later wallet/catalog refreshes fail.
- Administrator workspaces do not expose buyer checkout navigation.

## Test and build

```powershell
npm.cmd test
npm.cmd run build
```

The frontend/backend boundary and the server work still required for the reported issues are documented in [docs/FRONTEND_BACKEND_HANDOFF.md](docs/FRONTEND_BACKEND_HANDOFF.md).

## Backend integration

The repository also includes the backend delivery and refund workflows. Review and apply all pending migrations from the target commit (not only the original delivery migration 008), and configure deployment secrets before enabling protected features. See [API contract](docs/API.md), [local runbook](docs/LOCAL_RUNBOOK.md), and [staging runbook](docs/STAGING_RENDER_NEON.md). The frontend treats server-recorded refund eligibility as authoritative.

## Controlled staging CI/CD

See [the staging CI/CD guide](docs/STAGING_CICD.md) for automated tests, isolated PostgreSQL integration checks, pinned release artifacts, required migration acknowledgement, and manual publishing of the same commit to Render and Cloudflare Pages. Cloud migration and runtime secrets are deliberately kept outside this workflow. Hosted video remains disabled in `deployment/staging.json` until its separate worker, gateway and storage configuration are ready.
