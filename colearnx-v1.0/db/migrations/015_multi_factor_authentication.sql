-- Two-factor authentication (W4, threat model F-10, F-17, ASVS 2.8.1, 4.3.1).

-- One enrolment per account. The row exists from the moment enrolment starts;
-- confirmed_at is what makes it active, so an abandoned enrolment never leaves
-- an account half-protected and unable to sign in.
CREATE TABLE user_mfa_secrets (
  user_id uuid PRIMARY KEY REFERENCES users(user_id) ON DELETE RESTRICT,

  -- AES-256-GCM, keyed from MFA_SECRET_KEY in the environment. A TOTP secret
  -- is a bearer credential -- anyone holding it generates valid codes forever,
  -- and unlike a password hash there is nothing to crack. Storing it in
  -- plaintext would mean one database dump silently defeats two-factor for
  -- every enrolled account. The key is deliberately not in the database.
  secret_encrypted text NOT NULL,

  -- NULL while enrolment is pending. Sign-in only demands a second factor once
  -- this is set, which is what prevents a half-finished enrolment from locking
  -- the user out.
  confirmed_at timestamptz,

  -- The highest TOTP step this account has consumed. A code is valid for its
  -- whole window, so without this an observed code -- over the shoulder, from
  -- a phishing page, from a log -- can be replayed inside that window.
  last_used_step bigint,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_mfa_secrets_confirmed_idx
  ON user_mfa_secrets (confirmed_at)
  WHERE confirmed_at IS NOT NULL;

-- Recovery codes. Without them a lost phone is a permanent lockout whose only
-- remedy is an operator disabling MFA on request -- which becomes the weakest
-- link in the scheme and a standing social-engineering target.
--
-- Stored as an HMAC-SHA-256 digest keyed with SECURITY_HASH_PEPPER, not argon2.
-- Each code carries 100 bits, so there is no low-entropy guess to slow down,
-- and verifying a submission against ten argon2 hashes would cost a full
-- second per attempt.
CREATE TABLE user_recovery_codes (
  recovery_code_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  code_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Single use. Consumption is a conditional UPDATE, so two requests racing on
  -- one code produce one match and one miss.
  consumed_at timestamptz,
  UNIQUE (user_id, code_hash)
);

CREATE INDEX user_recovery_codes_available_idx
  ON user_recovery_codes (user_id)
  WHERE consumed_at IS NULL;

-- Lets the account page show "last seen" without the session having to be used
-- again, so a user reviewing their devices can tell a stale session from a
-- live one.
ALTER TABLE refresh_sessions ADD COLUMN last_used_at timestamptz;

-- 003 revoked default privileges; grant only what the runtime path needs.
GRANT SELECT, INSERT, UPDATE, DELETE ON user_mfa_secrets TO colearnx_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_recovery_codes TO colearnx_app;
REVOKE ALL PRIVILEGES ON user_mfa_secrets, user_recovery_codes
  FROM colearnx_readonly, colearnx_migrator;
