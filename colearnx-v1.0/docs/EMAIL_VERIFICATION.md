# Email-only account verification

New CoLearnX registrations must prove control of their email address before a
login session is created. This release sends an eight-digit code by email only:
it does not use SMS, WhatsApp, in-app messages, or any browser-to-database
access.

## Security controls

- Code lifetime: 10 minutes by default, configurable from 5 to 30 minutes.
- The database stores an HMAC-SHA-256 hash of the code, never the code itself.
- A code has at most five failed attempts by default. A new code is required
  after the limit.
- Resending is controlled both by an IP rate limit and a database-backed
  per-account cooldown (60 seconds by default).
- Login, token refresh, and protected API access refuse a newly registered,
  unverified account.
- Existing accounts are not changed or marked as verified by this migration.
  They have no verification-required timestamp, so the two existing staging
  accounts keep working exactly as before.

## Resend setup

Use a Resend account and its current free/developer allowance for small-volume
staging or MVP use. Its quota and sender-domain rules can change, so the
deployment owner must check the current Resend dashboard before relying on it
for a public launch.

1. Create the Resend account and verify the sender domain that will appear in
   the From address.
2. Create an API key limited to sending email.
3. Generate a separate code pepper locally:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

4. Put the following real values only in Render's secure environment editor:

```text
EMAIL_PROVIDER=resend
RESEND_API_KEY=<Resend API key>
EMAIL_FROM=CoLearnX <no-reply@your-verified-domain.example>
EMAIL_VERIFICATION_CODE_PEPPER=<generated random value>
EMAIL_VERIFICATION_CODE_TTL_MINUTES=10
EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS=60
EMAIL_VERIFICATION_MAX_ATTEMPTS=5
```

`RESEND_API_KEY` and `EMAIL_VERIFICATION_CODE_PEPPER` are secrets. Do not add
them to Git, a repository `.env`, screenshots, chat, or a Cloudflare Pages
variable. They belong only to the Express API host.

## Deployment sequence

1. Set all seven variables above in Render before the API is restarted. Staging
   and production deliberately refuse to start with email verification disabled.
2. Pull the approved commit and run the normal tests.
3. In the controlled migration environment, use the Neon owner/direct
   `MIGRATION_DATABASE_URL` and run `npm run db:migrate`. This applies
   `004_email_verification.sql`; it contains no user-data update or restore.
4. Deploy the API, then deploy the matching frontend release immediately.
   A browser holding the old frontend may need a refresh during this short
   compatibility window because registration no longer returns a session.
5. With a synthetic mailbox, register, receive the email, submit the code,
   sign in, and verify that an incorrect code is rejected and that resend waits
   for the cooldown.

If the mail provider is unavailable, the account remains unverified and the
API returns a retriable 503 response. The pending record is kept and its resend
cooldown is released, so the user can request another email after service
recovers. No user rows, existing accounts, or cloud data are overwritten.
