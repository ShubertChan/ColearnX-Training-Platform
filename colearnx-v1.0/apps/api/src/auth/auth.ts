import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { query, withTransaction } from '../db/database.js';
import { createOpaqueToken, sha256 } from '../lib/crypto.js';
import { ApiError, ok } from '../lib/http.js';
import { parse } from '../lib/validation.js';

export type Actor = { id: string; email: string; roles: string[]; status: string };

const credentialsSchema = z.object({ email: z.string().trim().email().max(320), password: z.string().min(8).max(256) });
const registrationSchema = credentialsSchema.extend({
  displayName: z.string().trim().min(1).max(120),
  passwordConfirmation: z.string().min(8).max(256),
  acceptedTerms: z.literal(true),
  ageAcknowledged: z.literal(true),
}).refine((input) => input.password === input.passwordConfirmation, {
  message: 'Passwords do not match.', path: ['passwordConfirmation'],
});
const accessTokenLifetime = '15m';
const refreshLifetimeMs = 1000 * 60 * 60 * 24 * 14;
const refreshCookieName = env.NODE_ENV === 'production' ? '__Host-colearnx-refresh' : 'colearnx_refresh';

function signAccessToken(actor: Actor) {
  return jwt.sign({ sub: actor.id, email: actor.email, roles: actor.roles }, env.ACCESS_TOKEN_SECRET, { expiresIn: accessTokenLifetime });
}

async function loadActor(userId: string): Promise<Actor | null> {
  const result = await query<Actor>(`SELECT u.user_id AS id, u.email::text AS email, u.account_status AS status,
    COALESCE(array_agg(r.role_code) FILTER (WHERE ur.revoked_at IS NULL), '{}') AS roles
    FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.user_id AND ur.revoked_at IS NULL
    LEFT JOIN roles r ON r.role_id = ur.role_id WHERE u.user_id = $1 GROUP BY u.user_id`, [userId]);
  return result.rows[0] ?? null;
}

function refreshCookieOptions() {
  return { httpOnly: true, secure: env.NODE_ENV === 'production' || env.NODE_ENV === 'staging', sameSite: 'lax' as const, domain: env.COOKIE_DOMAIN || undefined, path: '/api/v1/auth', maxAge: refreshLifetimeMs };
}

async function createRefreshSession(actor: Actor, req: Request, res: Response) {
  const token = createOpaqueToken();
  await query(`INSERT INTO refresh_sessions (user_id, token_hash, expires_at, user_agent, ip_hash) VALUES ($1, $2, $3, $4, $5)`, [actor.id, sha256(token), new Date(Date.now() + refreshLifetimeMs), req.get('user-agent')?.slice(0, 500) ?? null, sha256(req.ip || 'unknown')]);
  res.cookie(refreshCookieName, token, refreshCookieOptions());
}

const originIsAllowed = (req: Request) => !req.get('origin') || req.get('origin') === env.APP_ORIGIN;

export async function register(req: Request, res: Response) {
  const input = parse(registrationSchema, req.body);
  const actor = await withTransaction(async (client) => {
    const existing = await client.query('SELECT 1 FROM users WHERE lower(email::text) = lower($1)', [input.email]);
    if (existing.rowCount) throw new ApiError(409, 'EMAIL_ALREADY_REGISTERED', 'Unable to create this account.');
    const user = await client.query<{ id: string; email: string; status: string }>(`INSERT INTO users (full_name, email, password_hash) VALUES ($1, $2, $3) RETURNING user_id AS id, email::text AS email, account_status AS status`, [input.displayName, input.email, await argon2.hash(input.password, { type: argon2.argon2id })]);
    const userId = user.rows[0].id;
    await client.query(`INSERT INTO profiles (user_id, display_name) VALUES ($1, $2)`, [userId, input.displayName]);
    await client.query('INSERT INTO point_accounts (user_id) VALUES ($1)', [userId]);
    await client.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, role_id FROM roles WHERE role_code = 'member'`, [userId]);
    const bootstrapAdminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
    const isBootstrapAdmin = Boolean(bootstrapAdminEmail && input.email.toLowerCase() === bootstrapAdminEmail);
    if (isBootstrapAdmin) {
      await client.query(`INSERT INTO user_roles (user_id, role_id)
        SELECT $1, role_id FROM roles WHERE role_code = 'admin'
        ON CONFLICT (user_id, role_id) WHERE revoked_at IS NULL DO NOTHING`, [userId]);
    }
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json)
      VALUES ($1, 'auth.register', 'users', $2, jsonb_build_object('roles', $3::jsonb))`,
    [userId, userId, JSON.stringify(isBootstrapAdmin ? ['member', 'admin'] : ['member'])]);
    return { id: userId, email: user.rows[0].email, status: user.rows[0].status, roles: isBootstrapAdmin ? ['member', 'admin'] : ['member'] } satisfies Actor;
  });
  await createRefreshSession(actor, req, res);
  return ok(res, { user: actor, accessToken: signAccessToken(actor) }, 201);
}

export async function login(req: Request, res: Response) {
  const input = parse(credentialsSchema, req.body);
  const user = await query<{ id: string; password_hash: string }>('SELECT user_id AS id, password_hash FROM users WHERE lower(email::text) = lower($1)', [input.email]);
  const valid = user.rowCount ? await argon2.verify(user.rows[0].password_hash, input.password) : false;
  const actor = valid ? await loadActor(user.rows[0].id) : null;
  if (!valid || !actor || actor.status !== 'active') throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  await createRefreshSession(actor, req, res);
  return ok(res, { user: actor, accessToken: signAccessToken(actor) });
}

export async function refresh(req: Request, res: Response) {
  if (!originIsAllowed(req)) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'The request origin is not allowed.');
  const token = req.cookies?.[refreshCookieName] as string | undefined;
  if (!token) throw new ApiError(401, 'REFRESH_TOKEN_MISSING', 'Refresh session is missing.');
  const session = await query<{ id: string; user_id: string; revoked_at: Date | null; expires_at: Date }>('SELECT session_id AS id, user_id, revoked_at, expires_at FROM refresh_sessions WHERE token_hash = $1', [sha256(token)]);
  if (!session.rowCount) throw new ApiError(401, 'REFRESH_TOKEN_INVALID', 'Refresh session is invalid.');
  const current = session.rows[0];
  if (current.revoked_at) {
    await query('UPDATE refresh_sessions SET revoked_at = now(), revoke_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL', [current.user_id, 'refresh-token-reuse']);
    throw new ApiError(401, 'REFRESH_TOKEN_REUSED', 'Refresh session is no longer valid.');
  }
  if (current.expires_at <= new Date()) throw new ApiError(401, 'REFRESH_TOKEN_EXPIRED', 'Refresh session has expired.');
  const actor = await loadActor(current.user_id);
  if (!actor || actor.status !== 'active') throw new ApiError(401, 'ACCOUNT_UNAVAILABLE', 'Account is unavailable.');
  const newToken = createOpaqueToken();
  await withTransaction(async (client) => {
    const next = await client.query<{ id: string }>(`INSERT INTO refresh_sessions (user_id, token_hash, expires_at, user_agent, ip_hash) VALUES ($1, $2, $3, $4, $5) RETURNING session_id AS id`, [actor.id, sha256(newToken), new Date(Date.now() + refreshLifetimeMs), req.get('user-agent')?.slice(0, 500) ?? null, sha256(req.ip || 'unknown')]);
    await client.query('UPDATE refresh_sessions SET revoked_at = now(), revoke_reason = $2, replaced_by_session_id = $3 WHERE session_id = $1', [current.id, 'rotated', next.rows[0].id]);
  });
  res.cookie(refreshCookieName, newToken, refreshCookieOptions());
  return ok(res, { user: actor, accessToken: signAccessToken(actor) });
}

export async function logout(req: Request, res: Response) {
  if (!originIsAllowed(req)) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'The request origin is not allowed.');
  const token = req.cookies?.[refreshCookieName] as string | undefined;
  if (token) await query('UPDATE refresh_sessions SET revoked_at = now(), revoke_reason = $2 WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(token), 'logout']);
  res.clearCookie(refreshCookieName, refreshCookieOptions());
  return ok(res, { loggedOut: true });
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.get('authorization');
    if (!header?.startsWith('Bearer ')) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication is required.');
    const payload = jwt.verify(header.slice(7), env.ACCESS_TOKEN_SECRET);
    if (typeof payload === 'string' || !payload.sub) throw new ApiError(401, 'TOKEN_INVALID', 'Authentication token is invalid.');
    const actor = await loadActor(payload.sub);
    if (!actor || actor.status !== 'active') throw new ApiError(401, 'ACCOUNT_UNAVAILABLE', 'Account is unavailable.');
    res.locals.actor = actor;
    next();
  } catch (error) {
    next(error instanceof ApiError ? error : new ApiError(401, 'TOKEN_INVALID', 'Authentication token is invalid.'));
  }
}

export function requireRole(...roles: string[]) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const actor = res.locals.actor as Actor | undefined;
    if (!actor || !roles.some((role) => actor.roles.includes(role))) return next(new ApiError(403, 'FORBIDDEN', 'You are not allowed to perform this action.'));
    return next();
  };
}

export async function me(_req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const result = await query(`SELECT u.full_name, p.display_name, p.phone, p.location, p.bio
    FROM users u LEFT JOIN profiles p ON p.user_id = u.user_id WHERE u.user_id = $1`, [actor.id]);
  return ok(res, { ...actor, profile: result.rowCount ? {
    displayName: result.rows[0].display_name ?? result.rows[0].full_name,
    phone: result.rows[0].phone, location: result.rows[0].location, bio: result.rows[0].bio,
  } : null });
}

export async function updateMe(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(z.object({
    fullName: z.string().trim().min(1).max(120).optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    location: z.string().trim().max(160).nullable().optional(),
    bio: z.string().trim().max(2000).nullable().optional(),
  }).refine((value) => Object.keys(value).length > 0), req.body);
  const fullName = input.fullName ?? input.displayName;
  const has = (field: string) => Object.prototype.hasOwnProperty.call(input, field);
  const result = await withTransaction(async (client) => {
    const user = fullName ? await client.query(`UPDATE users SET full_name = $2, updated_at = now() WHERE user_id = $1 RETURNING full_name`, [actor.id, fullName]) : null;
    await client.query(`UPDATE profiles SET
      display_name = CASE WHEN $2 THEN $3 ELSE display_name END,
      phone = CASE WHEN $4 THEN $5 ELSE phone END,
      location = CASE WHEN $6 THEN $7 ELSE location END,
      bio = CASE WHEN $8 THEN $9 ELSE bio END,
      updated_at = now() WHERE user_id = $1`,
      [actor.id, Boolean(fullName), fullName ?? null, has('phone'), input.phone ?? null, has('location'), input.location ?? null, has('bio'), input.bio ?? null]);
    return user?.rows[0]?.full_name ?? input.displayName ?? null;
  });
  return ok(res, { displayName: result });
}
