import type { PoolClient } from 'pg';
import { ApiError } from '../lib/http.js';

export type PointEntry = {
  pointAccountId: string;
  entryRole: string;
  availableDelta?: number;
  frozenDelta?: number;
  expiredDelta?: number;
  blockedDelta?: number;
};

type PointTransactionInput = {
  type: 'topup' | 'purchase' | 'live_hold' | 'live_settlement' | 'refund' | 'admin_adjustment';
  reason: string;
  idempotencyKey?: string;
  topupOrderId?: string;
  orderItemId?: string;
  refundRequestId?: string;
  entries: PointEntry[];
};

/**
 * Posts a balanced, append-only point transaction.  Balances are a projection
 * of immutable ledger entries and are changed under row locks in this same
 * database transaction; callers never pass or trust client-side balances.
 */
export async function postPointTransaction(client: PoolClient, input: PointTransactionInput) {
  if (input.entries.length < 1) throw new ApiError(500, 'LEDGER_ENTRIES_REQUIRED', 'A point transaction requires at least one ledger entry.');
  const netDelta = input.entries.reduce(
    (total, entry) => total + (entry.availableDelta ?? 0) + (entry.frozenDelta ?? 0) + (entry.expiredDelta ?? 0) + (entry.blockedDelta ?? 0),
    0,
  );
  if (netDelta !== 0) throw new ApiError(500, 'LEDGER_UNBALANCED', 'Point transaction entries must balance to zero.');

  const accountIds = [...new Set(input.entries.map((entry) => entry.pointAccountId))].sort();
  const lockedAccounts = await client.query<{
    point_account_id: string;
    available_balance: string;
    frozen_balance: string;
    expired_balance: string;
    blocked_balance: string;
    account_status: string;
  }>(
    `SELECT point_account_id, available_balance, frozen_balance, expired_balance, blocked_balance, account_status
       FROM point_accounts
      WHERE point_account_id = ANY($1::uuid[])
      ORDER BY point_account_id
      FOR UPDATE`,
    [accountIds],
  );
  if (lockedAccounts.rowCount !== accountIds.length) {
    throw new ApiError(409, 'POINT_ACCOUNT_NOT_FOUND', 'A required point account is unavailable.');
  }
  const balances = new Map(lockedAccounts.rows.map((account) => [account.point_account_id, {
    available: Number(account.available_balance),
    frozen: Number(account.frozen_balance),
    expired: Number(account.expired_balance),
    blocked: Number(account.blocked_balance),
    status: account.account_status,
  }]));

  const transaction = await client.query<{ point_transaction_id: string }>(
    `INSERT INTO point_transactions (transaction_type, reason, idempotency_key, topup_order_id, order_item_id, refund_request_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING point_transaction_id`,
    [input.type, input.reason, input.idempotencyKey ?? null, input.topupOrderId ?? null, input.orderItemId ?? null, input.refundRequestId ?? null],
  );
  const pointTransactionId = transaction.rows[0].point_transaction_id;

  for (const entry of input.entries) {
    const availableDelta = entry.availableDelta ?? 0;
    const frozenDelta = entry.frozenDelta ?? 0;
    const expiredDelta = entry.expiredDelta ?? 0;
    const blockedDelta = entry.blockedDelta ?? 0;
    const account = balances.get(entry.pointAccountId)!;
    const nextAvailable = account.available + availableDelta;
    const nextFrozen = account.frozen + frozenDelta;
    const nextExpired = account.expired + expiredDelta;
    const nextBlocked = account.blocked + blockedDelta;
    if (account.status !== 'system' && (nextAvailable < 0 || nextFrozen < 0 || nextExpired < 0 || nextBlocked < 0)) {
      throw new ApiError(409, 'INSUFFICIENT_POINTS', 'You do not have enough available points.');
    }
    await client.query(
      `UPDATE point_accounts
       SET available_balance = $2, frozen_balance = $3, expired_balance = $4, blocked_balance = $5, updated_at = now()
       WHERE point_account_id = $1`,
      [entry.pointAccountId, nextAvailable, nextFrozen, nextExpired, nextBlocked],
    );
    await client.query(
      `INSERT INTO point_ledger_entries
        (point_transaction_id, point_account_id, entry_role, available_delta, frozen_delta, expired_delta, blocked_delta,
         available_balance_after, frozen_balance_after, expired_balance_after, blocked_balance_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [pointTransactionId, entry.pointAccountId, entry.entryRole, availableDelta, frozenDelta, expiredDelta, blockedDelta,
        nextAvailable, nextFrozen, nextExpired, nextBlocked],
    );
    account.available = nextAvailable;
    account.frozen = nextFrozen;
    account.expired = nextExpired;
    account.blocked = nextBlocked;
  }
  return pointTransactionId;
}

export async function loadUserPointAccount(client: PoolClient, userId: string, lock = false) {
  const account = await client.query<{ point_account_id: string; available_balance: string; frozen_balance: string; expired_balance: string; blocked_balance: string }>(
    `SELECT point_account_id, available_balance, frozen_balance, expired_balance, blocked_balance
     FROM point_accounts WHERE user_id = $1 AND account_status IN ('active', 'restricted')${lock ? ' FOR UPDATE' : ''}`,
    [userId],
  );
  if (!account.rowCount) throw new ApiError(409, 'POINT_ACCOUNT_NOT_FOUND', 'Your point account is unavailable.');
  return account.rows[0];
}

export async function loadSystemPointAccount(client: PoolClient) {
  const account = await client.query<{ point_account_id: string }>(`SELECT point_account_id FROM point_accounts WHERE account_status = 'system' ORDER BY created_at LIMIT 1 FOR UPDATE`);
  if (!account.rowCount) throw new ApiError(503, 'POINT_SYSTEM_UNAVAILABLE', 'The system point account is not configured.');
  return account.rows[0];
}
