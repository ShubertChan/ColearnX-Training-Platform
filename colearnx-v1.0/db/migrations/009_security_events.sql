-- Security event ledger (threat model F-12).
--
-- admin_action_logs records successful business actions and is written inside
-- the business transaction, so a rollback discards the audit trail with the
-- work. Security events must survive that rollback and must also record
-- attempts that never became a business action at all: failed logins, denied
-- authorisations, rate-limit hits, lockouts. They therefore live in a separate
-- table that is always written on its own connection, outside any transaction.
--
-- The table is append-only for the runtime role. colearnx_app receives
-- SELECT and INSERT and nothing else, so a compromised API credential cannot
-- erase its own traces. Retention deletion runs under the owner connection
-- used for migrations (see apps/api/src/security/retention.ts).
--
-- PRIVACY CONSTRAINT (ASVS 8.3.7, threat model F-05): actor_ip_hash and
-- actor_ua_hash are HMAC-SHA-256 keyed with SECURITY_HASH_PEPPER, never a bare
-- digest. A bare SHA-256 of an IPv4 address is exhaustively reversible in
-- minutes and is therefore not de-identification.
--
-- CONTEXT FIELD RULES (ASVS 7.3.3) -- the following must never be written into
-- context_json: passwords, password hashes, refresh or access tokens,
-- verification or reset codes, CSRF tokens, Stripe secrets, raw IP addresses,
-- raw user agents, full email addresses of third parties.

CREATE TABLE security_events (
  security_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),

  -- Dotted taxonomy, e.g. auth.login_failed. Kept as text rather than an enum
  -- so that adding an event type in W4-W8 does not require a table rewrite;
  -- the allowed set is enforced in TypeScript (security/taxonomy.ts).
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),

  -- 0 info, 1 low, 2 medium, 3 high, 4 critical.
  severity smallint NOT NULL CHECK (severity BETWEEN 0 AND 4),

  -- NULL when the event has no resolvable account, e.g. a login attempt
  -- against an address that was never registered.
  actor_user_id uuid REFERENCES users(user_id) ON DELETE RESTRICT,

  -- Present when the event concerns a different account than the actor,
  -- e.g. an administrator suspending a member.
  target_user_id uuid REFERENCES users(user_id) ON DELETE RESTRICT,

  actor_ip_hash char(64),
  actor_ua_hash char(64),
  request_id uuid,

  -- Reserved for the W7 rule engine. Written as 0 until then so that the
  -- dashboard and its indexes do not need a schema change in W7.
  risk_score smallint NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  rule_hits text[] NOT NULL DEFAULT '{}',

  decision text NOT NULL DEFAULT 'allow'
    CHECK (decision IN ('allow', 'challenge', 'deny', 'lock')),

  context_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Dashboard: "what happened to this account", newest first.
CREATE INDEX security_events_actor_recent_idx
  ON security_events (actor_user_id, occurred_at DESC)
  WHERE actor_user_id IS NOT NULL;

-- Dashboard: "how often is this event type firing", and the W7 velocity rules.
CREATE INDEX security_events_type_recent_idx
  ON security_events (event_type, occurred_at DESC);

-- W7 credential-stuffing detection: distinct accounts attacked per source.
CREATE INDEX security_events_ip_recent_idx
  ON security_events (actor_ip_hash, occurred_at DESC)
  WHERE actor_ip_hash IS NOT NULL;

-- Alert triage: the high and critical stream is small, so a partial index
-- keeps the operator view cheap even once the table is large.
CREATE INDEX security_events_severe_recent_idx
  ON security_events (occurred_at DESC)
  WHERE severity >= 3;

-- Append-only for the runtime role. The explicit REVOKE is redundant against
-- the GRANT above and is kept as executable documentation of the intent:
-- reviewers should not have to infer that omission was deliberate.
GRANT SELECT, INSERT ON security_events TO colearnx_app;
REVOKE UPDATE, DELETE, TRUNCATE ON security_events FROM colearnx_app;

-- The reporting login must not read authentication telemetry, consistent with
-- the restrictions 003 placed on users and refresh_sessions.
REVOKE ALL PRIVILEGES ON security_events FROM colearnx_readonly;
REVOKE ALL PRIVILEGES ON security_events FROM colearnx_migrator;
