# Data model

The team-maintained editable ERD is [CoLearnX ERD V5.1 Presentation Edition.drawio](https://github.com/ShubertChan/ColearnX-Training-Platform/blob/main/final%20report_material/Diagram/CoLearnX%20ERD%20V5.1%20Presentation%20Edition.drawio). PostgreSQL is the business source of truth; the browser never connects to it. `001_initial_schema.sql` implements the ERD naming and relationships; `002_commerce_hardening.sql` adds only the required profile, snapshot, revenue-allocation and four-balance ledger details.

The migration uses UUID public identifiers, UTC `timestamptz`, `bigint` for points and minor currency units, case-insensitive email uniqueness, explicit foreign keys, partial unique indexes, and generated PostgreSQL full-text indexes.

## Core relationships

- `users` has one `profiles` row and one active `point_accounts` row. Roles are grants in `user_roles`; refresh tokens are stored only as hashes in `refresh_sessions`.
- `courses`, `course_runs`, `contents`, and `content_versions` retain the ERD names. Course delivery is modeled by `course_delivery_options`, not a single overloaded format field.
- `orders` and `order_items` hold immutable price, seller, delivery, refund-policy and revenue-share snapshots. A course item creates a `course_enrolments` row; a content item creates a `content_access_grants` row.
- Stripe creates `point_topup_orders` and `payment_transactions`; verified webhook events create a balanced `point_transactions` / `point_ledger_entries` posting and update the point-account balance projection in the same transaction.
- `admin_action_logs`, `point_transactions`, and `point_ledger_entries` reject ordinary UPDATE and DELETE operations through PostgreSQL triggers.

## Important integrity and query support

| Rule/query | Database mechanism |
| --- | --- |
| Normalized user email | `users_email_normalized_uq` |
| One current role grant | partial unique `user_roles_active_uq` |
| One active enrolment per learner/course | partial unique `course_enrolments_active_uq` |
| Stripe event/session/payment intent replay protection | unique constraints on provider event and Stripe identifiers |
| Checkout replay protection | `(actor_id, scope, idempotency_key)` unique constraint |
| Marketplace course/content search | generated `tsvector`, GIN index, `websearch_to_tsquery` |
| Point-account/order cursor history | `(point_account_id, created_at DESC, ledger_entry_id DESC)` and `(buyer_user_id, created_at DESC, order_id DESC)` indexes |
| Final seat and point-account concurrency | `SELECT … FOR UPDATE` plus partial unique constraints inside one transaction |

`point_accounts.available_balance`, `frozen_balance`, `expired_balance`, and `blocked_balance` are projections changed only alongside append-only `point_ledger_entries`. Reconciliation can recompute balances from the ledger. A posted transaction always has signed entries that add to zero: issue→available, available→settlement, available→frozen, frozen→available, settlement→available, or an auditable admin adjustment.

## Commerce hardening

- The database has an active-policy uniqueness guard for `revenue_share_policies`, and an `earnings_allocations` deferred constraint requiring each order item to total exactly 10,000 basis points.
- `stripe_payment_events.stripe_event_id`, payment-provider identifiers, and operation-scoped idempotency records provide replay protection.
- Checkout uses an active revenue-share policy snapshot. The approved initial seed policy is 30% platform / 70% trainer for courses and 30% platform / 70% creator for content; later admin policy changes apply only to later orders.

## Migration policy

Run migrations with `colearnx_owner` through `MIGRATION_DATABASE_URL`, never through the API account. The running API uses `colearnx_app`; it has no UPDATE/DELETE grant on audit or ledger records. Future destructive changes must be forward migrations using expand → backfill → contract.

## Email verification

`004_email_verification.sql` adds nullable verification timestamps to `users` and one pending `email_verification_challenges` row per new account. The challenge contains only a keyed code hash, expiry, retry-after timestamp and failed-attempt count. The runtime role receives DML only on that challenge table; the reporting and legacy migrator roles receive no access.

Existing users leave both timestamps null and remain eligible to sign in. New registrations set `email_verification_required_at`; they gain access only after `email_verified_at` is written in the same transaction that deletes their one-time challenge.
