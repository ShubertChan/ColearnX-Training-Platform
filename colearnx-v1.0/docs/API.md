# API contract — MVP backend

Base URL: `http://localhost:3001/api/v1`. Every successful response is `{ "data": ..., "meta": { "requestId": "UUID" } }`; errors are `{ "error": { "code", "message", "details", "requestId" } }`.

Authenticated routes require `Authorization: Bearer <access-token>`. The refresh token is an HTTP-only cookie. Value-changing routes shown below require an `Idempotency-Key` header of 8–200 characters.

## Public and identity

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/register` | Creates an unverified account and emails an eight-digit code; returns no login session. |
| POST | `/auth/verify-email` | Body `{ "email", "code" }`; verifies the current one-time email code. |
| POST | `/auth/resend-verification` | Body `{ "email" }`; requests a new email code without disclosing account state. |
| POST | `/auth/forgot-password` | Body `{ "email" }`; always returns `202` without disclosing account state. A valid active account receives a one-time reset link. |
| POST | `/auth/reset-password` | Body `{ "token", "password", "passwordConfirmation" }`; consumes a single-use reset token and revokes existing refresh sessions. |
| POST | `/auth/login` | Creates an HTTP-only refresh cookie and returns an access token plus CSRF token. |
| GET | `/auth/csrf` | Returns the CSRF token associated with the current refresh cookie, if present. |
| POST | `/auth/refresh`, `/auth/logout` | Cookie-backed refresh-session lifecycle; requires `X-CSRF-Token` when a refresh cookie is present. |
| GET/PATCH | `/me` | Read/update profile. |
| GET | `/profiles/:id` | Public, minimised profile: display name, location, bio and public Trainer/Creator roles only. |
| POST | `/me/data-export`, `/me/deletion-requests` | Authenticated, deduplicated privacy requests; deletion body is `{ "reason" }`. |
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
| GET/POST/DELETE | `/cart`, `/cart/items`, `/cart/items/:id` | Durable Member-only draft cart. Prices and policy previews are informational; checkout always re-locks the product server-side. |
| POST/GET | `/refund-requests`, `/refund-requests/:id` | Submit and inspect a policy-evaluated refund request. |
| POST/GET | `/role-applications`, `/role-applications/me` | Request trainer or creator role and inspect decisions. |
| POST/GET | `/trainer-certifications`, `/trainer-certifications/me` | Trainer certification workflow. |
| GET | `/my/listings` | Current trainer/creator's own course drafts, course submissions, content drafts and content submissions. |
| POST | `/courses`, `/courses/:id/submit` | Trainer creates/submits a course run. |
| PATCH | `/courses/:id` | Trainer updates an owned draft with delivery modes, buyer-only Local/Live instructions, contact details, and optional hosted-video duration. |
| POST | `/content`, `/content/:id/submit` | Creator creates/submits content. |

## Private R2 content files

The browser never sends `storageUrl`, a bucket name, an object key, or R2 credentials. A Creator must first create a content draft, then can upload one or more permitted files through short-lived presigned URLs. The UI queues direct uploads one at a time; the API rechecks Creator ownership and draft state for every mutation.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/content-versions/:contentVersionId/assets` | Creator owner or administrator can list safe attachment metadata for a draft; a purchaser with a current grant can list ready published attachments. Never returns bucket, object key, signed URL or R2 credentials. |
| POST | `/content-versions/:contentVersionId/upload-intents` | Creator-only. Requires `Idempotency-Key`; body `{ filename, mediaType, sizeBytes, sha256? }`. Returns a short-lived direct `PUT` URL and required `Content-Type`. Allows PDF, DOCX, ZIP, JPEG, PNG and WebP up to 25 MiB; MP4 up to 100 MiB. The API also enforces a 500 MiB creator storage quota and a maximum of three incomplete uploads. Starting a new upload on the same draft safely clears incomplete prior attempts, not ready attachments. |
| POST | `/content-versions/:contentVersionId/upload-intents/:assetId/complete` | Creator-only. Uses R2 `HeadObject` to verify the stored MIME type and size, then atomically marks the asset `ready` without replacing other ready attachments. |
| DELETE | `/content-versions/:contentVersionId/upload-intents/:assetId` | Creator-only draft cleanup. It unlinks first, marks `delete_pending`, then removes the R2 object; a temporary R2 failure remains retryable. |
| POST | `/content-versions/:contentVersionId/download-url` | Owner, administrator, or purchaser with a current access grant only. Optional body `{ assetId }` chooses a ready attachment; omitting it uses the backwards-compatible primary file. Returns a short-lived attachment URL; signing it records a purchaser's first access. |
| POST | `/admin/content-versions/:contentVersionId/preview-url` | Administrator-only short-lived preview URL for a `ready` asset. Optional body `{ assetId }` selects a particular attachment. |

`POST /content/:id/submit` and admin publication both reject a content version that has no owned, non-deleted `ready` asset with `409 CONTENT_FILE_NOT_READY`. Public catalogue endpoints never return a bucket, object key, legacy storage URL, or signed URL.

## Private course delivery

Course uploads are separate from creator content uploads. Only the owning, operational Trainer can change an owned draft. Public course endpoints expose delivery modes only; buyer-only fulfilment instructions, Trainer contact and Live join URL are frozen in the order-item snapshot and returned only by purchase-authorised endpoints.

Refunds use the order's frozen policy snapshot. A self-arranged Local or Live course is eligible only when requested at least 72 hours before its confirmed start. Recorded videos/files are eligible only when server-recorded viewing is at or below 10% **and** no protected-file download has been recorded; the API, rather than the client preview, makes the final decision.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/courses/:courseRunId/assets` | Owner or administrator sees safe course-asset metadata; no object key, bucket or signed URL is returned. |
| POST | `/courses/:courseRunId/upload-intents` | Trainer draft upload intent. Requires `Idempotency-Key` and `{ filename, mediaType, sizeBytes, sha256? }`. |
| POST/DELETE | `/courses/:courseRunId/upload-intents/:assetId/complete` | Verify an R2 upload or schedule draft asset deletion. |
| GET | `/order-items/:orderItemId/delivery` | Buyer-only course delivery: protected cloud files, private fulfilment snapshot, and hosted-video player/progress metadata where applicable. |
| POST | `/order-items/:orderItemId/delivery/download-url` | Buyer-only protected cloud-download URL; body `{ assetId }`. |
| POST | `/order-items/:orderItemId/progress` | Buyer-only online-video progress report. The server clamps and de-duplicates ranges before persisting refund evidence. |


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

The React client uses this API directly: access tokens and CSRF tokens are kept in browser session storage, while the refresh token is an HTTP-only cookie. On a new tab or an expired access token, the client gets `/auth/csrf` and then calls `/auth/refresh` with `X-CSRF-Token`. The Vite development server proxies `/api` to port 3001, and the top-up UI submits only a server-issued package ID. Marketplace listings, orders, refunds, role applications, creator submissions, protected course delivery, hosted-video progress, public profiles, privacy requests and password reset are API-backed once migration `008_frontend_delivery_backend.sql` and the corresponding deployment secrets are configured.
