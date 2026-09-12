import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { withTransaction, query } from '../db/database.js';
import { ApiError, ok } from '../lib/http.js';
import { parse, uuid } from '../lib/validation.js';

const deletionInput = z.object({ reason: z.string().trim().min(5).max(2_000) }).strict();

async function createPrivacyRequest(actor: Actor, type: 'data_export' | 'account_deletion', reason: string | null, requestId?: string) {
  return withTransaction(async (client) => {
    await client.query('SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE', [actor.id]);
    const existing = await client.query<{ privacy_request_id: string; request_status: string }>(`SELECT privacy_request_id, request_status
      FROM privacy_requests WHERE user_id = $1 AND request_type = $2 AND request_status IN ('pending', 'in_progress')
      ORDER BY requested_at DESC LIMIT 1`, [actor.id, type]);
    if (existing.rowCount) return { id: existing.rows[0].privacy_request_id, status: existing.rows[0].request_status, duplicate: true };
    const created = await client.query<{ privacy_request_id: string; request_status: string }>(`INSERT INTO privacy_requests
      (user_id, request_type, reason, identity_verified_at) VALUES ($1, $2, $3, now())
      RETURNING privacy_request_id, request_status`, [actor.id, type, reason]);
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, $2, 'privacy_requests', $3, jsonb_build_object('outcome', 'pending'), $4)`,
    [actor.id, `privacy.${type}.requested`, created.rows[0].privacy_request_id, requestId ?? null]);
    return { id: created.rows[0].privacy_request_id, status: created.rows[0].request_status, duplicate: false };
  });
}

export async function getPublicProfile(req: Request, res: Response) {
  const userId = parse(uuid, req.params.id);
  const result = await query(`SELECT u.user_id, COALESCE(p.display_name, u.full_name) AS display_name, p.location, p.bio,
      COALESCE(array_agg(r.role_code) FILTER (WHERE r.role_code IN ('trainer', 'creator') AND ur.revoked_at IS NULL), '{}') AS roles
    FROM users u LEFT JOIN profiles p ON p.user_id = u.user_id
    LEFT JOIN user_roles ur ON ur.user_id = u.user_id AND ur.revoked_at IS NULL
    LEFT JOIN roles r ON r.role_id = ur.role_id
    WHERE u.user_id = $1 AND u.account_status = 'active'
    GROUP BY u.user_id, p.profile_id`, [userId]);
  if (!result.rowCount) throw new ApiError(404, 'PROFILE_NOT_FOUND', 'Public profile was not found.');
  const profile = result.rows[0];
  return ok(res, { id: profile.user_id, displayName: profile.display_name, location: profile.location, bio: profile.bio, roles: profile.roles });
}

export async function requestDataExport(_req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const request = await createPrivacyRequest(actor, 'data_export', null, res.locals.requestId);
  return ok(res, { id: request.id, status: request.status, accepted: true, duplicate: request.duplicate }, 202);
}

export async function requestAccountDeletion(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(deletionInput, req.body);
  const request = await createPrivacyRequest(actor, 'account_deletion', input.reason, res.locals.requestId);
  return ok(res, { id: request.id, status: request.status, accepted: true, duplicate: request.duplicate }, 202);
}
