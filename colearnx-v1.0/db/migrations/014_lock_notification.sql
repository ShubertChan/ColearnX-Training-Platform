-- Out-of-band notification for account lockout (W4).
--
-- Email is the only channel that can carry "your account was locked" safely.
-- The sign-in page is a public surface: anything shown there is shown to
-- whoever triggered the lock, so a visible countdown would tell an attacker
-- which addresses are real accounts and turn the lockout into the enumeration
-- oracle it exists to prevent. A message delivered to the registered address
-- reaches only someone who already controls that mailbox, so it discloses
-- nothing to an attacker while giving the account holder the one signal they
-- would otherwise never get.
--
-- The column below is what stops the notification becoming its own abuse
-- vector. Without it, an attacker can lock an account, wait for the lock to
-- expire, lock it again, and use the platform to flood a victim's inbox --
-- turning a protective notice into a harassment tool. One notification per
-- cooldown window closes that.

ALTER TABLE auth_failure_counters ADD COLUMN last_lock_notified_at timestamptz;

-- The claim is a conditional UPDATE on this column, so two concurrent
-- lockouts cannot both send: exactly one UPDATE reports a matched row. The
-- partial index keeps that claim cheap once the table has many rows, most of
-- which will never have been notified.
CREATE INDEX auth_failure_counters_notified_idx
  ON auth_failure_counters (last_lock_notified_at)
  WHERE last_lock_notified_at IS NOT NULL;
