import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/database.js';

// Every refresh/revocation takes this lock first, so a refresh cannot insert a
// successor just after a revoke-all statement has selected its target rows.
export function withSessionLock<T>(userId: string, work: (client: PoolClient) => Promise<T>) {
  return withTransaction(async (client) => {
    await client.query('SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE', [userId]);
    return work(client);
  });
}

/** Resolve one login through refresh-token rotation, never through revocation.
 * Access tokens remain usable during an ordinary refresh, but ending the active
 * leaf also ends access through every older token in that same session chain.
 */
export async function resolveActiveSession(sessionId: string, userId: string, client?: PoolClient): Promise<string | null> {
  const sql = `WITH RECURSIVE chain AS (
       SELECT session_id, user_id, revoked_at, revoke_reason, replaced_by_session_id,
              expires_at, ARRAY[session_id] AS visited
         FROM refresh_sessions WHERE session_id = $1 AND user_id = $2
       UNION ALL
       SELECT s.session_id, s.user_id, s.revoked_at, s.revoke_reason,
              s.replaced_by_session_id, s.expires_at, c.visited || s.session_id
         FROM refresh_sessions s JOIN chain c ON s.session_id = c.replaced_by_session_id
        WHERE c.revoked_at IS NOT NULL AND c.revoke_reason = 'rotated'
          AND s.user_id = $2 AND NOT s.session_id = ANY(c.visited)
          AND cardinality(c.visited) < 64
     )
     SELECT session_id FROM chain WHERE revoked_at IS NULL AND expires_at > now() LIMIT 1`;
  const result = client
    ? await client.query<{ session_id: string }>(sql, [sessionId, userId])
    : await query<{ session_id: string }>(sql, [sessionId, userId]);
  return result.rows[0]?.session_id ?? null;
}
