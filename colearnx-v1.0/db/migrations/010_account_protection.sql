-- Progressive login lockout (threat model F-02) and password-age tracking.
--
-- 008 already introduced password_reset_challenges, so this migration does not
-- create a reset table. The reset flow built there is kept; what it lacked --
-- a per-account cooldown, a server-side strength policy and a change
-- notification -- is addressed in application code, not schema.

-- Distinguishes a password set under the strengthened policy from one that
-- predates it. Existing accounts are deliberately grandfathered: forcing every
-- user to reset at once would be its own incident. The new policy applies at
-- registration and at reset. NULL means "set before 010".
ALTER TABLE users ADD COLUMN password_changed_at timestamptz;

-- One row per account that has failed at least once. The row survives a
-- successful login (counters zeroed, lockout_count retained) because repeat
-- lockout history is an input to the W7 risk score.
--
-- DESIGN NOTE: lockout is a denial-of-service primitive. An attacker who knows
-- a victim's address can lock them out on demand. Three properties make that
-- acceptable:
--   1. every lock expires on its own, so the worst case is a delay rather than
--      an account loss requiring support intervention;
--   2. a locked account is indistinguishable from a wrong password in the HTTP
--      response, so the mechanism is not also an enumeration oracle;
--   3. completing a password reset clears the lock, giving the victim a
--      self-service escape.
CREATE TABLE auth_failure_counters (
  user_id uuid PRIMARY KEY REFERENCES users(user_id) ON DELETE RESTRICT,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  last_failure_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  -- Lifetime count of times this account has entered a lock. Never reset.
  lockout_count integer NOT NULL DEFAULT 0 CHECK (lockout_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Supports the operator view "which accounts are locked right now".
CREATE INDEX auth_failure_counters_locked_idx
  ON auth_failure_counters (locked_until DESC)
  WHERE locked_until IS NOT NULL;

-- Supports the per-account reset cooldown added on top of the 008 flow:
-- "when did this user last request a link". 008 indexed the table for token
-- lookup and for the pending-row uniqueness constraint, neither of which
-- answers that question without a scan.
CREATE INDEX password_reset_challenges_user_recent_idx
  ON password_reset_challenges (user_id, requested_at DESC);

-- 003 revoked default privileges; grant only what the runtime path needs.
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_failure_counters TO colearnx_app;
REVOKE ALL PRIVILEGES ON auth_failure_counters FROM colearnx_readonly, colearnx_migrator;
