import { env } from '../../config/env.js';
import { query, withTransaction } from '../../db/database.js';
import {
  generateRecoveryCodes, hashRecoveryCode, normaliseRecoveryCode, recoveryCodeCount,
} from './recovery-codes.js';
import { decryptSecret, deriveMfaKey, encryptSecret } from './secret-store.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';

/**
 * Database-bound half of multi-factor authentication. The pure halves -- TOTP,
 * secret encryption, recovery codes, challenge tokens -- live in sibling
 * modules with their own tests, the same split this codebase uses elsewhere.
 */

const mfaKey = deriveMfaKey(env.MFA_SECRET_KEY);

export type MfaState = {
  enrolled: boolean;
  pending: boolean;
  confirmedAt: Date | null;
  recoveryCodesRemaining: number;
};

export async function readMfaState(userId: string): Promise<MfaState> {
  const result = await query<{ confirmed_at: Date | null; remaining: string }>(
    `SELECT s.confirmed_at,
            (SELECT count(*) FROM user_recovery_codes c
              WHERE c.user_id = s.user_id AND c.consumed_at IS NULL) AS remaining
       FROM user_mfa_secrets s WHERE s.user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return { enrolled: false, pending: false, confirmedAt: null, recoveryCodesRemaining: 0 };
  return {
    enrolled: Boolean(row.confirmed_at),
    pending: !row.confirmed_at,
    confirmedAt: row.confirmed_at,
    recoveryCodesRemaining: Number.parseInt(row.remaining, 10) || 0,
  };
}

export const mfaRequired = (state: MfaState) => state.enrolled;

/**
 * Starts or restarts enrolment.
 *
 * A pending enrolment is always replaced rather than resumed: the user may
 * have lost the device they scanned the first secret with, and resuming would
 * hand them a secret they can no longer generate codes for. Restarting is
 * harmless because a pending secret protects nothing yet.
 *
 * An already-confirmed enrolment is NOT replaced. Re-enrolling must go through
 * disable, which requires a current factor -- otherwise anyone holding a live
 * session could silently swap the second factor for one of their own, which
 * would make MFA worse than useless.
 */
export async function beginEnrolment(userId: string, accountEmail: string) {
  const secret = generateTotpSecret();
  // ON CONFLICT locks the current row and rechecks this predicate after any
  // concurrent confirmation commits. A prior SELECT cannot make that guarantee.
  const result = await query(
    `INSERT INTO user_mfa_secrets (user_id, secret_encrypted, confirmed_at, last_used_step)
     VALUES ($1, $2, NULL, NULL)
     ON CONFLICT (user_id) DO UPDATE SET
       secret_encrypted = $2, last_used_step = NULL, updated_at = now()
     WHERE user_mfa_secrets.confirmed_at IS NULL
     RETURNING user_id`,
    [userId, encryptSecret(secret, mfaKey)],
  );
  if (!result.rowCount) return { alreadyEnrolled: true as const };
  return {
    alreadyEnrolled: false as const,
    secret,
    otpauthUri: otpauthUri(secret, accountEmail),
  };
}

export type ConfirmResult =
  | { status: 'confirmed'; recoveryCodes: string[] }
  | { status: 'no-pending' }
  | { status: 'invalid-code' };

/**
 * Confirms enrolment by proving the user can generate a code, then issues the
 * recovery codes.
 *
 * Recovery codes are issued only at this point, never at enrolment start: a
 * user who abandons enrolment should not be left holding codes for a factor
 * that was never activated.
 */
export async function confirmEnrolment(userId: string, submittedCode: string): Promise<ConfirmResult> {
  return withTransaction(async (client) => {
    const row = await client.query<{ secret_encrypted: string; confirmed_at: Date | null }>(
      'SELECT secret_encrypted, confirmed_at FROM user_mfa_secrets WHERE user_id = $1 FOR UPDATE',
      [userId],
    );
    const record = row.rows[0];
    if (!record || record.confirmed_at) return { status: 'no-pending' as const };

    const verification = verifyTotp(decryptSecret(record.secret_encrypted, mfaKey), submittedCode, Date.now(), null);
    if (!verification.valid) return { status: 'invalid-code' as const };

    await client.query(
      'UPDATE user_mfa_secrets SET confirmed_at = now(), last_used_step = $2, updated_at = now() WHERE user_id = $1',
      [userId, verification.step],
    );

    const codes = generateRecoveryCodes();
    await client.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [userId]);
    await client.query(
      `INSERT INTO user_recovery_codes (user_id, code_hash)
       SELECT $1, unnest($2::char(64)[])`,
      [userId, codes.map((code) => hashRecoveryCode(code, env.SECURITY_HASH_PEPPER))],
    );
    return { status: 'confirmed' as const, recoveryCodes: codes };
  });
}

export type FactorResult =
  | { ok: true; usedRecoveryCode: boolean; recoveryCodesRemaining: number }
  | { ok: false; reason: 'not-enrolled' | 'invalid' };

/**
 * Verifies a second factor: a TOTP code, or a recovery code.
 *
 * Both are accepted at the same endpoint and are distinguished by shape, so
 * the caller never has to ask the user which kind they are holding.
 *
 * The TOTP branch persists the consumed step inside the transaction that
 * checks it. Doing the check and the write separately would let two concurrent
 * submissions of the same code both pass.
 */
export async function verifySecondFactor(userId: string, submitted: string): Promise<FactorResult> {
  const trimmed = submitted.trim();
  const looksLikeTotp = /^[0-9\s]{6,8}$/.test(trimmed);

  return withTransaction(async (client) => {
    const row = await client.query<{ secret_encrypted: string; confirmed_at: Date | null; last_used_step: string | null }>(
      'SELECT secret_encrypted, confirmed_at, last_used_step FROM user_mfa_secrets WHERE user_id = $1 FOR UPDATE',
      [userId],
    );
    const record = row.rows[0];
    if (!record || !record.confirmed_at) return { ok: false as const, reason: 'not-enrolled' as const };

    if (looksLikeTotp) {
      const lastStep = record.last_used_step === null ? null : Number.parseInt(record.last_used_step, 10);
      const verification = verifyTotp(decryptSecret(record.secret_encrypted, mfaKey), trimmed, Date.now(), lastStep);
      if (!verification.valid) return { ok: false as const, reason: 'invalid' as const };
      await client.query(
        'UPDATE user_mfa_secrets SET last_used_step = $2, updated_at = now() WHERE user_id = $1',
        [userId, verification.step],
      );
      const remaining = await client.query<{ count: string }>(
        'SELECT count(*) FROM user_recovery_codes WHERE user_id = $1 AND consumed_at IS NULL', [userId],
      );
      return {
        ok: true as const,
        usedRecoveryCode: false,
        recoveryCodesRemaining: Number.parseInt(remaining.rows[0].count, 10) || 0,
      };
    }

    // Recovery branch. The conditional UPDATE is what enforces single use:
    // two requests racing on one code produce one match and one miss.
    const consumed = await client.query<{ recovery_code_id: string }>(
      `UPDATE user_recovery_codes SET consumed_at = now()
        WHERE user_id = $1 AND code_hash = $2 AND consumed_at IS NULL
        RETURNING recovery_code_id`,
      [userId, hashRecoveryCode(normaliseRecoveryCode(trimmed), env.SECURITY_HASH_PEPPER)],
    );
    if (!consumed.rowCount) return { ok: false as const, reason: 'invalid' as const };

    const remaining = await client.query<{ count: string }>(
      'SELECT count(*) FROM user_recovery_codes WHERE user_id = $1 AND consumed_at IS NULL', [userId],
    );
    return {
      ok: true as const,
      usedRecoveryCode: true,
      recoveryCodesRemaining: Number.parseInt(remaining.rows[0].count, 10) || 0,
    };
  });
}

/** Replaces the whole set. Any unused old code stops working immediately. */
export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await withTransaction(async (client) => {
    await client.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [userId]);
    await client.query(
      `INSERT INTO user_recovery_codes (user_id, code_hash) SELECT $1, unnest($2::char(64)[])`,
      [userId, codes.map((code) => hashRecoveryCode(code, env.SECURITY_HASH_PEPPER))],
    );
  });
  return codes;
}

export async function disableMfa(userId: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM user_mfa_secrets WHERE user_id = $1', [userId]);
  });
}

export const recoveryCodesPerSet = recoveryCodeCount;
