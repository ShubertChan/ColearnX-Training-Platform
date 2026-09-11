# Frontend/backend handoff — 2026-09-11

This archive is frontend-only. The UI now exposes the required flows, but security, financial correctness and cross-device persistence depend on server implementation. A `404` or validation error from one of the routes below is a backend integration gap, not permission to fabricate access in the browser.

## Required API additions

| Area | Route/response required by the frontend | Security requirement |
| --- | --- | --- |
| Course fulfilment | `GET /order-items/:id/delivery` returns safe asset metadata, buyer-only `instructions`, `trainerContact`, optional `joinUrl`, and online-video progress/player metadata | Verify the current user owns an active order item; never return object keys or credentials |
| Cloud course download | `POST /order-items/:id/delivery/download-url` with `{ assetId }` returns a short-lived URL | Purchase grant check on every request; record download/access evidence |
| Video progress | `POST /order-items/:id/progress` with authoritative `watchedSeconds` and `totalDurationSeconds` | Clamp, de-duplicate and calculate ratio on the server; do not trust refund eligibility from the client |
| Course authoring | `POST/PATCH /courses` accepts buyer-only `fulfilmentInstructions`, `trainerContact`, `joinUrl`, `progressTrackingType`, `totalDurationSeconds`; a separate protected upload-intent flow is still required for Cloud course files | Trainer ownership plus approved certification capability |
| Password reset | `POST /auth/forgot-password`, `POST /auth/reset-password` | Identical forgot response for all emails; random one-time token, short expiry, hashed storage, rate limits and session revocation |
| Public profile | `GET /profiles/:id` | Return approved public fields only |
| Privacy requests | `POST /me/data-export`, `POST /me/deletion-requests` | Authenticated, audited, identity-verified and retention-aware |
| Draft cart | Server cart endpoints are still needed to replace the browser `localStorage` fallback | Associate with the authenticated Member and revalidate every item at checkout |
| Admin/Member boundary | `/checkout` must reject Admin-only accounts | Server role/capability check; frontend navigation is not a security boundary |
| Refund policy | Catalogue/detail and checkout responses must include the exact policy preview/snapshot | Do not infer policy from Cloud/Local/Live; only explicit `online_video` products use the ≤10% progress condition |

## Existing responses that need additional fields

- Registration and resend-verification responses: `expiresAt`, `resendAvailableAt`.
- `/me`: capability flags such as `canCreateCourse` or `trainerOperational` after certification approval.
- Catalogue items: complete public description/category/type plus `refundPolicyPreview`, `progressTrackingType` and `totalDurationSeconds` when applicable.
- Order detail: seller, transaction reference, delivery snapshot, refund-policy snapshot, fulfilment status, buyer-only delivery fields and refund records.
- Wallet transactions: all four deltas, balances after the transaction, real status, order reference and refund reference.
- Paginated lists: page/cursor metadata and total where feasible.

## Scope not falsely marked complete

F-15 describes several complete role/state-machine products, not isolated UI bugs. Editing/version history, licensing/combination, cancellation, reporting, abuse reports, audit-log exploration and admin points adjustment require matching domain APIs and end-to-end tests. They should be delivered as separate vertical slices. This frontend does not invent successful mutations for those missing services.
