# API contract — MVP backend

Base URL: `http://localhost:3001/api/v1`. Every successful response is `{ "data": ..., "meta": { "requestId": "UUID" } }`; errors are `{ "error": { "code", "message", "details", "requestId" } }`.

Authenticated routes require `Authorization: Bearer <access-token>`. The refresh token is an HTTP-only cookie. Value-changing routes shown below require an `Idempotency-Key` header of 8–200 characters.

## Public and identity

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/register` | Creates an unverified account and emails an eight-digit code; returns no login session. |
| POST | `/auth/verify-email` | Body `{ "email", "code" }`; verifies the current one-time email code. |
| POST | `/auth/resend-verification` | Body `{ "email" }`; requests a new email code without disclosing account state. |
| POST | `/auth/login` | Creates an HTTP-only refresh cookie and returns an access token plus CSRF token. |
| GET | `/auth/csrf` | Returns the CSRF token associated with the current refresh cookie, if present. |
| POST | `/auth/refresh`, `/auth/logout` | Cookie-backed refresh-session lifecycle; requires `X-CSRF-Token` when a refresh cookie is present. |
| GET/PATCH | `/me` | Read/update profile. |
| GET | `/courses`, `/courses/:id`, `/content`, `/content/:id` | Published marketplace listing/detail. |

## Learner, creator and trainer

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/wallet`, `/wallet/transactions` | Available/Frozen/Expired/Blocked balances and immutable ledger history. |
| GET | `/wallet/top-up-packages` | Active server-side Stripe test packages only. |
| POST | `/wallet/top-ups/checkout-session` | Body `{ "topUpPackageId": "UUID" }`; returns a Stripe Checkout URL. Never accepts client amount or points. |
| GET | `/wallet/top-ups/:id` | Poll a top-up state after redirect. |
| POST | `/checkout` | Body `{ "items": [{ "kind": "course|content", "id": "UUID" }] }`; creates order, snapshots and ledger posting. |
| GET | `/orders`, `/orders/:id` | Order history/detail. |
| POST/GET | `/refund-requests`, `/refund-requests/:id` | Submit and inspect a policy-evaluated refund request. |
| POST/GET | `/role-applications`, `/role-applications/me` | Request trainer or creator role and inspect decisions. |
| POST/GET | `/trainer-certifications`, `/trainer-certifications/me` | Trainer certification workflow. |
| GET | `/my/listings` | Current trainer/creator's own course drafts, course submissions, content drafts and content submissions. |
| POST | `/courses`, `/courses/:id/submit` | Trainer creates/submits a course run. |
| POST | `/content`, `/content/:id/submit` | Creator creates/submits content. |

## Admin-only operations

All routes below also require the `admin` role.

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/admin/role-applications`, `/admin/role-applications/:id/decision` | Review and grant role. |
| GET/POST | `/admin/trainer-certifications`, `/admin/trainer-certifications/:id/decision` | Review certification. |
| GET/POST | `/admin/course-submissions`, `/admin/course-runs/:id/decision` | Review course submission; publishing activates its delivery options. |
| GET/POST | `/admin/content-submissions`, `/admin/content-versions/:id/decision` | Review content version. |
| GET/POST | `/admin/refund-requests`, `/admin/refund-requests/:id/decision` | Review queued policy-eligible refunds. |
| GET | `/admin/users?status=&search=&page=&limit=` | List user accounts, their active roles and account status. |
| GET | `/admin/users/:id` | Read one user profile and active roles; the administrator access is audited. |
| POST | `/admin/users/:id/suspend` | Freeze an account and revoke active refresh sessions; body `{ reason }`. |
| POST | `/admin/users/:id/reinstate` | Restore a suspended non-administrator account; body `{ reason }`. |
| POST | `/admin/users/:id/roles` | Grant or revoke `trainer`, `creator` or `admin`; body `{ roleCode, action: "grant"|"revoke", reason }`. Self-changes and removal of the last active administrator are blocked. |
| DELETE | `/admin/users/:id` | Permanently remove a non-administrator account's access while retaining financial/moderation history; body `{ reason }`. |
| PUT | `/admin/revenue-share-policies/course_run` or `/content_version` | Activate an approved 10,000-basis-point policy. |
| POST | `/admin/top-up-packages`, `/admin/top-up-packages/:id/retire` | Configure or retire server-side payment packages. |
| POST | `/admin/points/adjustments` | Audited, idempotent manual adjustment; body `{ userId, deltaPoints, reason }`. |
| POST | `/admin/course-runs/:id/complete` | Release started Live-course holds to settlement. |
| POST | `/admin/course-runs/:id/cancel` | Refund active Live-course holds to learners. |

## Stripe webhook

`POST /api/v1/payments/stripe/webhook` is intentionally outside the authenticated router. It receives the raw body, verifies `Stripe-Signature` with `STRIPE_WEBHOOK_SECRET`, rejects live events, and processes only test-mode `checkout.session.completed`. Configure it through the Stripe CLI in local development; never call it from the browser.

The React client uses this API directly: access tokens and CSRF tokens are kept in browser session storage, while the refresh token is an HTTP-only cookie. On a new tab or an expired access token, the client gets `/auth/csrf` and then calls `/auth/refresh` with `X-CSRF-Token`. The Vite development server proxies `/api` to port 3001, and the top-up UI submits only a server-issued package ID. Stripe Checkout returns to `/#/wallet` with a payment transaction ID; the wallet polls the authenticated status endpoint and refreshes its ledger-backed balance after webhook confirmation. Marketplace listings, orders, refunds, role applications, creator submissions and administrator queues are API-backed. The cart is an in-memory pre-checkout selection only; it is not a source of truth for prices, enrolment, points, orders, roles or entitlement. Secure file delivery, hosted-video progress, public profiles, Google OAuth and password-reset email remain disabled until their dedicated back-end integrations are implemented.
