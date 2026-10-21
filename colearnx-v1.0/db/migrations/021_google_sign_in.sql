-- A Google identity points at the existing user, never a second wallet/profile.
CREATE TABLE google_identities (
  google_subject text PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Browser-bound, short-lived, single-use nonces; no Google tokens are stored.
CREATE TABLE google_login_challenges (
  nonce_hash text PRIMARY KEY,
  browser_hash text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX google_login_challenges_expiry_idx ON google_login_challenges (expires_at);

-- Explicit grants also work when migrations run under a different owner.
REVOKE ALL ON google_identities, google_login_challenges FROM colearnx_app;
GRANT SELECT, INSERT ON google_identities TO colearnx_app;
GRANT SELECT, INSERT, DELETE ON google_login_challenges TO colearnx_app;
-- SELECT FOR UPDATE needs update permission on at least one column.
GRANT UPDATE (nonce_hash) ON google_login_challenges TO colearnx_app;
