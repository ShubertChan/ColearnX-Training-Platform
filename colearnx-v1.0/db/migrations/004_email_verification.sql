-- Email verification is an additive, forward-only release. Existing accounts
-- remain usable: only registrations created after this migration set
-- email_verification_required_at and therefore require a verified address.

ALTER TABLE users
  ADD COLUMN email_verified_at timestamptz,
  ADD COLUMN email_verification_required_at timestamptz;

-- Store only an HMAC-SHA-256 of the short-lived code. The code itself is
-- returned to neither the database nor the audit log and is sent only by email.
CREATE TABLE email_verification_challenges (
  user_id uuid PRIMARY KEY REFERENCES users(user_id) ON DELETE RESTRICT,
  code_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  resend_available_at timestamptz NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (resend_available_at >= created_at)
);

-- 003 removed default grants. Grant the runtime role only the table access
-- needed to create, replace, validate and remove a pending challenge.
GRANT SELECT, INSERT, UPDATE, DELETE ON email_verification_challenges TO colearnx_app;
REVOKE ALL PRIVILEGES ON email_verification_challenges FROM colearnx_migrator, colearnx_readonly;
