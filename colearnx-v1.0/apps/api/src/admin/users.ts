import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { query, withTransaction } from '../db/database.js';
import { ApiError, ok } from '../lib/http.js';
import { parse, uuid } from '../lib/validation.js';

const listUsersInput = z.object({
  status: z.enum(['active', 'suspended', 'deleted']).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const accountActionInput = z.object({ reason: z.string().trim().min(3).max(2_000) });
const roleActionInput = z.object({
  roleCode: z.enum(['trainer', 'creator', 'admin']),
  action: z.enum(['grant', 'revoke']),
  reason: z.string().trim().min(3).max(2_000),
});

type UserRow = {
  user_id: string;
  full_name: string;
  display_name: string | null;
  email: string;
  account_status: 'active' | 'suspended' | 'deleted';
  created_at: Date;
  updated_at: Date;
  role_codes: string[];
  total_count?: string;
};

type UserDetailRow = UserRow & {
  phone: string | null;
  location: string | null;
  bio: string | null;
};

function userResponse(row: UserRow) {
  return {
    id: row.user_id,
    displayName: row.display_name ?? row.full_name,
    email: row.email,
    status: row.account_status,
    roles: row.role_codes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function userDetailResponse(row: UserDetailRow) {
  return {
    ...userResponse(row),
    profile: {
      fullName: row.full_name,
      displayName: row.display_name ?? row.full_name,
      phone: row.phone,
      location: row.location,
      bio: row.bio,
    },
  };
}

async function findUserDetail(userId: string) {
  const result = await query<UserDetailRow>(`SELECT u.user_id, u.full_name, p.display_name, u.email::text AS email,
    u.account_status, u.created_at, u.updated_at, p.phone, p.location, p.bio,
    COALESCE(array_agg(r.role_code) FILTER (WHERE ur.revoked_at IS NULL), ARRAY[]::text[]) AS role_codes
    FROM users u
    LEFT JOIN profiles p ON p.user_id = u.user_id
    LEFT JOIN user_roles ur ON ur.user_id = u.user_id AND ur.revoked_at IS NULL
    LEFT JOIN roles r ON r.role_id = ur.role_id
    WHERE u.user_id = $1
    GROUP BY u.user_id, u.full_name, p.display_name, p.phone, p.location, p.bio, u.email, u.account_status, u.created_at, u.updated_at`, [userId]);
  return result.rows[0] ?? null;
}

export async function listUsers(req: Request, res: Response) {
  const input = parse(listUsersInput, req.query);
  const offset = (input.page - 1) * input.limit;
  const result = await query<UserRow>(`SELECT u.user_id, u.full_name, p.display_name, u.email::text AS email,
    u.account_status, u.created_at, u.updated_at,
    COALESCE(array_agg(r.role_code) FILTER (WHERE ur.revoked_at IS NULL), ARRAY[]::text[]) AS role_codes,
    count(*) OVER() AS total_count
    FROM users u
    LEFT JOIN profiles p ON p.user_id = u.user_id
    LEFT JOIN user_roles ur ON ur.user_id = u.user_id AND ur.revoked_at IS NULL
    LEFT JOIN roles r ON r.role_id = ur.role_id
    WHERE ($1::text IS NULL OR u.account_status = $1)
      AND ($2::text IS NULL OR lower(u.email::text) LIKE '%' || lower($2) || '%'
        OR lower(u.full_name) LIKE '%' || lower($2) || '%'
        OR lower(COALESCE(p.display_name, '')) LIKE '%' || lower($2) || '%')
    GROUP BY u.user_id, u.full_name, p.display_name, u.email, u.account_status, u.created_at, u.updated_at
    ORDER BY u.created_at DESC, u.user_id DESC
    LIMIT $3 OFFSET $4`, [input.status ?? null, input.search ?? null, input.limit, offset]);
  return ok(res, {
    items: result.rows.map(userResponse),
    page: input.page,
    limit: input.limit,
    total: result.rowCount ? Number(result.rows[0].total_count ?? 0) : 0,
  });
}

export async function getUser(req: Request, res: Response) {
  const admin = res.locals.actor as Actor;
  const userId = parse(uuid, req.params.id);
  const user = await findUserDetail(userId);
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User was not found.');
  await query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, request_id)
    VALUES ($1, 'admin.user.view', 'users', $2, $3)`, [admin.id, userId, res.locals.requestId]);
  return ok(res, userDetailResponse(user));
}

async function updateAccountStatus(req: Request, res: Response, nextStatus: 'active' | 'suspended' | 'deleted', actionType: string) {
  const admin = res.locals.actor as Actor;
  const userId = parse(uuid, req.params.id);
  const input = parse(accountActionInput, req.body);
  const user = await withTransaction(async (client) => {
    const target = await client.query<{ user_id: string; account_status: 'active' | 'suspended' | 'deleted' }>(
      `SELECT user_id, account_status FROM users WHERE user_id = $1 FOR UPDATE`, [userId],
    );
    if (!target.rowCount) throw new ApiError(404, 'USER_NOT_FOUND', 'User was not found.');
    const current = target.rows[0];
    const roles = await client.query<{ role_code: string }>(`SELECT r.role_code FROM user_roles ur
      JOIN roles r ON r.role_id = ur.role_id WHERE ur.user_id = $1 AND ur.revoked_at IS NULL`, [userId]);
    if (current.user_id === admin.id) throw new ApiError(409, 'SELF_ACCOUNT_ACTION_FORBIDDEN', 'Administrators cannot change their own account status.');
    if (roles.rows.some((role) => role.role_code === 'admin')) throw new ApiError(409, 'ADMIN_ACCOUNT_PROTECTED', 'Use a separate audited administrator-recovery procedure for another administrator account.');
    if (current.account_status === nextStatus) throw new ApiError(409, 'ACCOUNT_STATUS_UNCHANGED', 'The account already has this status.');
    if (nextStatus === 'active' && current.account_status !== 'suspended') throw new ApiError(409, 'ACCOUNT_NOT_REINSTATABLE', 'Only suspended accounts can be reinstated.');
    if (current.account_status === 'deleted') throw new ApiError(409, 'ACCOUNT_DELETED', 'A deleted account cannot be changed through this endpoint.');

    await client.query(`UPDATE users SET account_status = $2, updated_at = now() WHERE user_id = $1`, [userId, nextStatus]);
    if (nextStatus !== 'active') {
      await client.query(`UPDATE refresh_sessions SET revoked_at = now(), revoke_reason = $2
        WHERE user_id = $1 AND revoked_at IS NULL`, [userId, `account-${nextStatus}`]);
    }
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, $2, 'users', $3, jsonb_build_object('previousStatus', $4::text, 'newStatus', $5::text, 'reason', $6::text), $7)`,
    [admin.id, actionType, userId, current.account_status, nextStatus, input.reason, res.locals.requestId]);

    const updated = await client.query<UserRow>(`SELECT u.user_id, u.full_name, p.display_name, u.email::text AS email,
      u.account_status, u.created_at, u.updated_at,
      COALESCE(array_agg(r.role_code) FILTER (WHERE ur.revoked_at IS NULL), ARRAY[]::text[]) AS role_codes,
      '1' AS total_count
      FROM users u
      LEFT JOIN profiles p ON p.user_id = u.user_id
      LEFT JOIN user_roles ur ON ur.user_id = u.user_id AND ur.revoked_at IS NULL
      LEFT JOIN roles r ON r.role_id = ur.role_id
      WHERE u.user_id = $1
      GROUP BY u.user_id, u.full_name, p.display_name, u.email, u.account_status, u.created_at, u.updated_at`, [userId]);
    return updated.rows[0];
  });
  return ok(res, userResponse(user));
}

export const suspendUser = (req: Request, res: Response) => updateAccountStatus(req, res, 'suspended', 'admin.user.suspended');
export const reinstateUser = (req: Request, res: Response) => updateAccountStatus(req, res, 'active', 'admin.user.reinstated');
// Keep the user row and finance history for auditability; deletion disables all access permanently.
export const deleteUser = (req: Request, res: Response) => updateAccountStatus(req, res, 'deleted', 'admin.user.deleted');

export async function changeUserRole(req: Request, res: Response) {
  const admin = res.locals.actor as Actor;
  const userId = parse(uuid, req.params.id);
  const input = parse(roleActionInput, req.body);
  await withTransaction(async (client) => {
    const target = await client.query<{ user_id: string; account_status: 'active' | 'suspended' | 'deleted' }>(
      `SELECT user_id, account_status FROM users WHERE user_id = $1 FOR UPDATE`, [userId],
    );
    if (!target.rowCount) throw new ApiError(404, 'USER_NOT_FOUND', 'User was not found.');
    if (target.rows[0].user_id === admin.id) throw new ApiError(409, 'SELF_ROLE_ACTION_FORBIDDEN', 'Administrators cannot change their own roles.');
    if (target.rows[0].account_status !== 'active') throw new ApiError(409, 'ACCOUNT_NOT_ACTIVE', 'Only active accounts can have roles changed.');

    const role = await client.query<{ role_id: string }>(`SELECT role_id FROM roles WHERE role_code = $1`, [input.roleCode]);
    if (!role.rowCount) throw new ApiError(503, 'ROLE_CONFIGURATION_INVALID', 'The requested role is not configured.');
    const assignment = await client.query<{ user_role_id: string }>(`SELECT user_role_id FROM user_roles
      WHERE user_id = $1 AND role_id = $2 AND revoked_at IS NULL FOR UPDATE`, [userId, role.rows[0].role_id]);

    if (input.action === 'grant') {
      if (assignment.rowCount) throw new ApiError(409, 'ROLE_ALREADY_GRANTED', 'The account already has this role.');
      await client.query(`INSERT INTO user_roles (user_id, role_id, assigned_by_user_id) VALUES ($1, $2, $3)`, [userId, role.rows[0].role_id, admin.id]);
    } else {
      if (!assignment.rowCount) throw new ApiError(409, 'ROLE_NOT_GRANTED', 'The account does not currently have this role.');
      if (input.roleCode === 'admin') {
        const count = await client.query<{ total: number }>(`SELECT count(*)::int AS total FROM user_roles ur
          JOIN roles r ON r.role_id = ur.role_id
          JOIN users u ON u.user_id = ur.user_id
          WHERE r.role_code = 'admin' AND ur.revoked_at IS NULL AND u.account_status = 'active'`);
        if (count.rows[0].total <= 1) throw new ApiError(409, 'LAST_ADMIN_ROLE_PROTECTED', 'The last active administrator role cannot be removed.');
      }
      await client.query(`UPDATE user_roles SET revoked_at = now() WHERE user_role_id = $1`, [assignment.rows[0].user_role_id]);
    }

    await client.query(`UPDATE refresh_sessions SET revoked_at = now(), revoke_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL`, [userId, `role-${input.action}`]);
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, $2, 'users', $3, jsonb_build_object('roleCode', $4::text, 'reason', $5::text), $6)`,
    [admin.id, `admin.user_role.${input.action}`, userId, input.roleCode, input.reason, res.locals.requestId]);
  });
  const updated = await findUserDetail(userId);
  if (!updated) throw new ApiError(404, 'USER_NOT_FOUND', 'User was not found.');
  return ok(res, userDetailResponse(updated));
}
