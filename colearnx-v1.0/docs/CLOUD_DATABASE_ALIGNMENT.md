# Cloud database alignment and hardening

## Baseline verified on 2026-08-31

The supplied cloud migration ledger contains `001_initial_schema.sql` and
`002_commerce_hardening.sql`. Both SHA-256 checksums exactly match the current
repository files. The supplied cloud schema also contains the tables and
indexes created by those migrations.

This means the cloud database is already aligned with the local schema
baseline. Do **not** import a local dump, run `pg_restore`, use `--clean`, or
replace the cloud database. Those operations are unnecessary and could destroy
the existing user accounts.

## What migration 003 changes

`003_enterprise_access_and_query_hardening.sql` is forward-only and contains
no data manipulation statements. It preserves every existing row while it:

- removes broad access from the unused legacy `colearnx_migrator` login;
- hides credentials, sessions, payment diagnostics, and sensitive audit data
  from the read-only login;
- protects `schema_migrations` from application roles;
- prevents untrusted roles from creating objects in `public`;
- stops automatic DML grants for tables created by future migrations; and
- adds indexes for checkout, enrolment capacity, role-review, and live-hold
  query paths.

The runtime API keeps its existing access. Future migrations must explicitly
grant only the permissions required by the API for each newly created table.

## Deployment procedure

1. Take a provider snapshot/backup and record the release commit.
2. Deploy the API build that contains the line-ending-safe migration checksum
   logic and migration `003`.
3. From the controlled deployment environment, set only the owner/direct
   `MIGRATION_DATABASE_URL` and run `npm run db:migrate` once. Do not use the
   runtime API `DATABASE_URL` and do not use `colearnx_migrator`.
4. Verify without reading user data:

   ```sql
   SELECT filename, checksum, applied_at
   FROM schema_migrations
   ORDER BY filename;

   SELECT indexname
   FROM pg_indexes
   WHERE schemaname = 'public'
     AND indexname IN (
       'course_delivery_options_active_run_delivery_idx',
       'course_enrolments_active_run_idx',
       'role_applications_applicant_submitted_idx',
       'role_applications_pending_review_idx',
       'point_holds_active_purchase_idx'
     )
   ORDER BY indexname;
   ```

5. Run the API health checks and the checkout, role-application, and Stripe
   test-mode smoke tests. Roll forward with a new migration if a change needs
   correction; do not restore a local database over the cloud database.
