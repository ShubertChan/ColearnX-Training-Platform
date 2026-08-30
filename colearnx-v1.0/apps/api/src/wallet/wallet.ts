import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { query } from '../db/database.js';
import { ApiError, ok } from '../lib/http.js';
import { parse } from '../lib/validation.js';

export async function wallet(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const result = await query<{ point_account_id: string; available_balance: string; frozen_balance: string; expired_balance: string; blocked_balance: string; account_status: string }>(
    `SELECT point_account_id, available_balance, frozen_balance, expired_balance, blocked_balance, account_status
     FROM point_accounts WHERE user_id = $1 AND account_status IN ('active', 'restricted')`,
    [actor.id],
  );
  if (!result.rowCount) throw new ApiError(404, 'POINT_ACCOUNT_NOT_FOUND', 'Point account was not found.');
  const row = result.rows[0];
  return ok(res, {
    id: row.point_account_id,
    availablePoints: Number(row.available_balance),
    frozenPoints: Number(row.frozen_balance),
    expiredPoints: Number(row.expired_balance),
    blockedPoints: Number(row.blocked_balance),
    accountStatus: row.account_status,
  });
}

export async function walletTransactions(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(z.object({ cursor: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }), req.query);
  const result = await query(`SELECT pt.point_transaction_id, pt.transaction_type, pt.reason, pt.created_at, ple.entry_role,
      ple.available_delta, ple.frozen_delta, ple.expired_delta, ple.blocked_delta
    FROM point_accounts pa JOIN point_ledger_entries ple ON ple.point_account_id = pa.point_account_id
    JOIN point_transactions pt ON pt.point_transaction_id = ple.point_transaction_id
    WHERE pa.user_id = $1 AND pa.account_status IN ('active', 'restricted')
      AND ($2::timestamptz IS NULL OR pt.created_at < $2::timestamptz)
    ORDER BY pt.created_at DESC, pt.point_transaction_id DESC LIMIT $3`, [actor.id, input.cursor ?? null, input.limit]);
  const items = result.rows.map((row) => ({ id: row.point_transaction_id, type: row.transaction_type, reference: row.reason,
    createdAt: row.created_at, entryRole: row.entry_role, availableDelta: Number(row.available_delta), frozenDelta: Number(row.frozen_delta),
    expiredDelta: Number(row.expired_delta), blockedDelta: Number(row.blocked_delta) }));
  return ok(res, items, 200, { nextCursor: items.length === input.limit ? items.at(-1)?.createdAt : null });
}

export async function topUpPackages(_req: Request, res: Response) {
  const result = await query(`SELECT point_topup_package_id, package_code, display_name, fiat_amount, currency_code, points_amount
    FROM point_topup_packages WHERE is_active = true AND retired_at IS NULL ORDER BY fiat_amount ASC`);
  return ok(res, result.rows.map((row) => ({ id: row.point_topup_package_id, code: row.package_code, displayName: row.display_name, amountMinor: Number(row.fiat_amount), currency: row.currency_code, points: Number(row.points_amount) })));
}
