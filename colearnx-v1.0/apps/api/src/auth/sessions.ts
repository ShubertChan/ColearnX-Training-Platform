import type { Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../db/database.js';
import { sha256 } from '../lib/crypto.js';
import { ApiError, ok } from '../lib/http.js';
import { parse } from '../lib/validation.js';
import { recordSecurityEvent, securityContext } from '../security/events.js';
import type { Actor } from './auth.js';
import { refreshCookieName } from './auth.js';

/**
 * Session visibility and revocation (threat model F-17, ASVS 3.3.3, 3.3.4).
 *
 * Before this, `logout` revoked only the session making the call. A user whose
 * account had been taken over had no way to end the attacker's session and no
 * way to see that it existed; their only option was to wait out a fourteen-day
 * refresh token. Self-service revocation is what makes account recovery
 * actually recover the account.
 */

const idSchema = z.object({ id: z.string().uuid() });

/**
 * Describes a device without pretending to more precision than we have.
 *
 * Only a coarse family is derived from the user agent. A confident but wrong
 * "iPhone 14 in Singapore" is worse than "Safari on iOS": the whole purpose of
 * this screen is for the user to recognise their own sessions, and a wrong
 * label either causes panic or gets ignored. No geolocation is shown for the
 * same reason, and because only a keyed fingerprint of the address is stored
 * (threat model F-05).
 */
export function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const ua = userAgent.toLowerCase();
  const platform = ua.includes('iphone') || ua.includes('ipad') ? 'iOS'
    : ua.includes('android') ? 'Android'
    : ua.includes('mac os') || ua.includes('macintosh') ? 'macOS'
    : ua.includes('windows') ? 'Windows'
    : ua.includes('linux') ? 'Linux'
    : 'Unknown platform';
  const browser = ua.includes('edg/') ? 'Edge'
    : ua.includes('chrome/') && !ua.includes('edg/') ? 'Chrome'
    : ua.includes('firefox/') ? 'Firefox'
    : ua.includes('safari/') && !ua.includes('chrome/') ? 'Safari'
    : 'Unknown browser';
  return `${browser} on ${platform}`;
}

export async function listSessions(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const currentToken = req.cookies?.[refreshCookieName] as string | undefined;
  const currentHash = currentToken ? sha256(currentToken) : null;

  const result = await query<{
    session_id: string; created_at: Date; last_used_at: Date | null;
    expires_at: Date; user_agent: string | null; token_hash: string;
  }>(
    `SELECT session_id, created_at, last_used_at, expires_at, user_agent, token_hash
       FROM refresh_sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY coalesce(last_used_at, created_at) DESC`,
    [actor.id],
  );

  return ok(res, {
    sessions: result.rows.map((row) => ({
      id: row.session_id,
      device: describeUserAgent(row.user_agent),
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      // Marking the current session is what makes "revoke the others" a safe
      // action to offer: the user can see which row is the one they are on.
      current: currentHash !== null && row.token_hash === currentHash,
    })),
  });
}

export async function revokeSession(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(idSchema, req.params);

  // Scoped to the acting user in the WHERE clause rather than checked
  // afterwards, so a session id belonging to someone else simply matches
  // nothing -- no row is read, and the response cannot distinguish "not yours"
  // from "does not exist".
  const result = await query(
    `UPDATE refresh_sessions SET revoked_at = now(), revoke_reason = 'user-revoked'
      WHERE session_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [input.id, actor.id],
  );
  if (!result.rowCount) throw new ApiError(404, 'SESSION_NOT_FOUND', 'That session is no longer active.');

  await recordSecurityEvent(securityContext(req, res), {
    type: 'session.revoked_one', actorUserId: actor.id, context: { reason: 'user-revoked' },
  }, res);
  return ok(res, { revoked: true });
}

/**
 * Ends every session except the one making the request.
 *
 * Keeping the caller signed in is deliberate. The alternative -- signing
 * everything out including the current browser -- means a user acting on a
 * suspected compromise is immediately thrown back to a sign-in page, which
 * both feels like a failure and gives an attacker a chance to race them back
 * in. Leaving the initiating session alive lets the user continue to the next
 * step, which is usually changing their password.
 */
export async function revokeOtherSessions(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const currentToken = req.cookies?.[refreshCookieName] as string | undefined;
  const currentHash = currentToken ? sha256(currentToken) : null;

  const result = await query(
    `UPDATE refresh_sessions SET revoked_at = now(), revoke_reason = 'user-revoked-all'
      WHERE user_id = $1 AND revoked_at IS NULL
        AND ($2::text IS NULL OR token_hash <> $2)`,
    [actor.id, currentHash],
  );

  await recordSecurityEvent(securityContext(req, res), {
    type: 'session.revoked_all', actorUserId: actor.id,
    context: { reason: 'user-revoked-all', count: result.rowCount ?? 0, keptCurrent: currentHash !== null },
  }, res);
  return ok(res, { revoked: result.rowCount ?? 0 });
}
