import argon2 from 'argon2';
import type { PoolClient } from 'pg';
import { createOpaqueToken } from '../lib/crypto.js';
import { ApiError } from '../lib/http.js';
import type { GoogleIdentity } from './google-identity.js';

type GoogleAccount = { id: string; status: string; email_verified_at: Date | null; email_verification_required_at: Date | null };

export async function resolveGoogleAccount(client: PoolClient, identity: GoogleIdentity, consent: boolean) {
  // Serialize first-time requests for one subject, including a Workspace email
  // rename. The normalized users index also serializes password registrations.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`google:${identity.subject}`]);
  const linked = await client.query<GoogleAccount>(`SELECT u.user_id AS id, u.account_status AS status,
      u.email_verified_at, u.email_verification_required_at
    FROM google_identities g JOIN users u ON u.user_id = g.user_id
    WHERE g.google_subject = $1 FOR UPDATE OF u`, [identity.subject]);
  let account = linked.rows[0];
  if (account) {
    assertActive(account);
    return { userId: account.id, created: false };
  }
  let created = false;
  const existing = await client.query<GoogleAccount>(`SELECT user_id AS id, account_status AS status,
      email_verified_at, email_verification_required_at
    FROM users WHERE lower(email::text) = lower($1) FOR UPDATE`, [identity.email]);
  account = existing.rows[0];
  if (!account) {
    if (!consent) return { registrationRequired: true as const };
    const inserted = await client.query<GoogleAccount>(`INSERT INTO users
        (full_name, email, password_hash, email_verified_at)
      VALUES ($1, $2, $3, now()) ON CONFLICT (lower(email::text)) DO NOTHING
      RETURNING user_id AS id, account_status AS status, email_verified_at, email_verification_required_at`,
    [identity.name, identity.email, await argon2.hash(createOpaqueToken(), { type: argon2.argon2id })]);
    account = inserted.rows[0];
    created = Boolean(account);
    if (!account) {
      account = (await client.query<GoogleAccount>(`SELECT user_id AS id, account_status AS status,
          email_verified_at, email_verification_required_at
        FROM users WHERE lower(email::text) = lower($1) FOR UPDATE`, [identity.email])).rows[0];
    }
  }
  assertActive(account);
  const other = await client.query('SELECT google_subject FROM google_identities WHERE user_id = $1', [account.id]);
  if (other.rowCount) throw new ApiError(409, 'GOOGLE_ACCOUNT_CONFLICT', 'This account is linked to a different Google account. Sign in with your email and password.');
  if (created) {
    await client.query('INSERT INTO profiles (user_id, display_name) VALUES ($1, $2)', [account.id, identity.name]);
    await client.query('INSERT INTO point_accounts (user_id) VALUES ($1)', [account.id]);
    await client.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, role_id FROM roles WHERE role_code = 'member'`, [account.id]);
  } else if (account.email_verification_required_at && !account.email_verified_at) {
    // An attacker may have pre-registered the victim's mailbox. Proving the
    // mailbox must not validate the attacker's unverified password or sessions.
    await client.query('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE user_id = $1',
      [account.id, await argon2.hash(createOpaqueToken(), { type: argon2.argon2id })]);
    await client.query(`UPDATE refresh_sessions SET revoked_at = now(), revoke_reason = 'google-email-verification'
      WHERE user_id = $1 AND revoked_at IS NULL`, [account.id]);
    await client.query('UPDATE password_reset_challenges SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL', [account.id]);
  }
  await client.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE user_id = $1', [account.id]);
  await client.query('DELETE FROM email_verification_challenges WHERE user_id = $1', [account.id]);
  await client.query('INSERT INTO google_identities (google_subject, user_id) VALUES ($1, $2)', [identity.subject, account.id]);
  await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json)
    VALUES ($1::uuid, $2, 'users', $1::uuid::text, $3::jsonb)`,
  [account.id, created ? 'auth.google_registered' : 'auth.google_linked', JSON.stringify({ method: 'google', ...(created ? { acceptedTerms: true, ageAcknowledged: true } : {}) })]);
  return { userId: account.id, created };
}

function assertActive(account: GoogleAccount | undefined): asserts account is GoogleAccount {
  if (!account || account.status !== 'active') throw new ApiError(403, 'GOOGLE_ACCOUNT_UNAVAILABLE', 'This account cannot sign in. Contact support.');
}
