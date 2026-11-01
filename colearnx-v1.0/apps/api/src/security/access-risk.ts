import { isIP } from 'node:net';
import { ipKeyGenerator } from 'express-rate-limit';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { env } from '../config/env.js';
import { query, withTransaction } from '../db/database.js';
import { ApiError } from '../lib/http.js';
import {
  insertSecurityEvent, notifySecurityEvent, securityContext, systemFingerprint,
  type RequestFingerprint, type SecurityEventInput,
} from './events.js';
import { emailFingerprint, fingerprint, ipFingerprint } from './fingerprint.js';

const windowMinutes = 10;
const reviewAt = 5, denyAt = 8, topupAt = 5;
const sources = {
  login: { observation: 'auth.login_failed', finding: 'auth.credential_stuffing', rule: 'cross_account_login_failures' },
  register: { observation: 'auth.registration_attempt', finding: 'auth.registration_burst', rule: 'distinct_registration_targets' },
} as const;
type Flow = keyof typeof sources;

// Express has already applied TRUST_PROXY. Never read X-Forwarded-For directly.
export function sourceKeys(ip: string | undefined, pepper: string) {
  if (!ip || !isIP(ip)) return null;
  const source = ipKeyGenerator(ip, 64); // mapped IPv4 -> IPv4; IPv6 -> /64
  const network = isIP(source) === 4 ? source.replace(/\.\d+$/, '.0/24') : source;
  return { ipHash: ipFingerprint(source, pepper), network: fingerprint('network', network, pepper) };
}
function requestKeys(req: Request) {
  return sourceKeys(req.ip, env.SECURITY_HASH_PEPPER) ?? sourceKeys(req.socket.remoteAddress, env.SECURITY_HASH_PEPPER);
}
const lockScope = (client: PoolClient, scope: string) =>
  client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['auth-risk:' + scope]);
const write = (client: PoolClient, fp: RequestFingerprint, input: SecurityEventInput) =>
  insertSecurityEvent(fp, input, (sql, values) => client.query(sql, values));

// Each denied source gets a fixed cooldown from its first finding. Blocked
// requests cannot refresh it; another source can still use the same account.
const recentDeny = `SELECT ceil(extract(epoch FROM (occurred_at + $3 * interval '1 minute' - statement_timestamp())))::int AS seconds
  FROM security_events WHERE actor_ip_hash = $1 AND event_type = $2 AND decision = 'deny'
  AND occurred_at > statement_timestamp() - $3 * interval '1 minute' ORDER BY occurred_at DESC LIMIT 1`;
function refuse(res: Response, seconds: number): never {
  res.set('Retry-After', String(Math.max(1, seconds)));
  throw new ApiError(429, 'SOURCE_COOLDOWN', 'Too many attempts from this source. Please try again later.');
}
function unavailable(res: Response, error: unknown): never {
  res.locals.log?.error({ err: error, requestId: res.locals.requestId }, 'Authentication source check unavailable');
  throw new ApiError(503, 'SOURCE_CHECK_UNAVAILABLE', 'Account protection is temporarily unavailable. Please try again.');
}
export async function checkLoginSource(req: Request, res: Response) {
  const keys = requestKeys(req);
  if (!keys) return;
  const found = await query(recentDeny, [keys.ipHash, sources.login.finding, windowMinutes]).catch(error => unavailable(res, error));
  if (found.rowCount) refuse(res, found.rows[0].seconds);
}

export async function observeSource(flow: Flow, req: Request, res: Response, email: string,
  detail: Pick<SecurityEventInput, 'actorUserId' | 'context'> = {}) {
  const keys = requestKeys(req);
  const fp = { ...securityContext(req, res), ...(keys && { ipHash: keys.ipHash }) };
  const { observation, finding, rule } = sources[flow];
  const attempt: SecurityEventInput = { ...detail, type: observation, context: {
    ...detail.context, subject: emailFingerprint(email, env.SECURITY_HASH_PEPPER),
  } };
  const result = await withTransaction(async client => {
    await lockScope(client, flow + ':' + fp.ipHash);
    const active = await client.query(recentDeny, [fp.ipHash, finding, windowMinutes]);
    if (active.rowCount) return { alreadyDenied: true, seconds: active.rows[0].seconds as number };
    await write(client, fp, attempt);
    if (!keys) return {};
    const { rows } = await client.query<{ n: number }>(`SELECT count(DISTINCT context_json->>'subject')::int AS n
      FROM security_events WHERE actor_ip_hash = $1 AND event_type = $2
      AND occurred_at > statement_timestamp() - $3 * interval '1 minute'`, [keys.ipHash, observation, windowMinutes]);
    const count = rows[0].n;
    if (count < reviewAt) return {};
    const deny = count >= denyAt;
    const decision = deny ? 'deny' : env.TURNSTILE_SITE_KEY ? 'challenge' : 'allow';
    const recent = await client.query(`SELECT 1 FROM security_events WHERE actor_ip_hash = $1 AND event_type = $2
      AND decision = $3 AND occurred_at > statement_timestamp() - $4 * interval '1 minute' LIMIT 1`,
    [keys.ipHash, finding, decision, windowMinutes]);
    if (recent.rowCount) return {};
    const event: SecurityEventInput = { type: finding, severity: deny ? 3 : 2, decision, ruleHits: [rule],
      riskScore: deny ? 85 : 55, context: { distinctTargets: count, windowMinutes } };
    await write(client, fp, event);
    return { event, seconds: deny ? windowMinutes * 60 : undefined };
  }).catch(error => unavailable(res, error));
  if (!result.alreadyDenied) notifySecurityEvent(fp, attempt);
  if (result.event) notifySecurityEvent(fp, result.event);
  if (result.seconds != null) refuse(res, result.seconds);
}

// A change of network can be a VPN or phone handover. Compare completed
// sessions only and flag the change for review; never revoke the session here.
export async function recordLoginSuccess(req: Request, res: Response, actor: string, context: Record<string, unknown>) {
  const fp = securityContext(req, res);
  const keys = requestKeys(req);
  const success: SecurityEventInput = { type: 'auth.login_succeeded', actorUserId: actor,
    context: { ...context, ...(keys && { network: keys.network }) } };
  try {
    const finding = await withTransaction(async client => {
      await lockScope(client, 'session:' + actor);
      const recent = await client.query(`SELECT context_json->>'network' AS network FROM security_events
        WHERE actor_user_id = $1 AND event_type = 'auth.login_succeeded' AND context_json ? 'network'
        AND occurred_at > statement_timestamp() - interval '15 minutes' ORDER BY occurred_at DESC LIMIT 1`, [actor]);
      await write(client, fp, success);
      if (!keys || !recent.rowCount || recent.rows[0].network === keys.network) return;
      const flagged = await client.query(`SELECT 1 FROM security_events WHERE actor_user_id = $1
        AND event_type = 'auth.login_network_changed' AND occurred_at > statement_timestamp() - interval '15 minutes' LIMIT 1`, [actor]);
      if (flagged.rowCount) return;
      const event: SecurityEventInput = { type: 'auth.login_network_changed', actorUserId: actor, decision: 'allow',
        riskScore: 55, ruleHits: ['rapid_network_change'], context: { windowMinutes: 15 } };
      await write(client, fp, event);
      return event;
    });
    notifySecurityEvent(fp, success);
    if (finding) notifySecurityEvent(fp, finding);
  } catch (error) { res.locals.log?.error({ err: error, requestId: fp.requestId }, 'Failed to record login risk'); }
}

// Call inside the verified payment transaction, only after an order first
// becomes credited. Use the canonical orders (never webhook delivery counts).
// An audit failure may not roll back a valid payment.
export async function assessCreditedTopups(client: PoolClient, actor: string, res: Response) {
  await client.query('SAVEPOINT topup_risk');
  try {
    await lockScope(client, 'topup:' + actor);
    const counts = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM point_topup_orders o
      JOIN point_accounts a ON a.point_account_id = o.point_account_id
      WHERE a.user_id = $1 AND o.topup_status = 'paid' AND o.credited_at > statement_timestamp() - $2 * interval '1 minute'`,
    [actor, windowMinutes]);
    let event: SecurityEventInput | undefined;
    if (counts.rows[0].n >= topupAt) {
      const seen = await client.query(`SELECT 1 FROM security_events WHERE actor_user_id = $1 AND event_type = 'finance.topup_velocity'
        AND occurred_at > statement_timestamp() - $2 * interval '1 minute' LIMIT 1`, [actor, windowMinutes]);
      if (!seen.rowCount) {
        event = { type: 'finance.topup_velocity', actorUserId: actor, decision: 'allow', riskScore: 70,
          ruleHits: ['credited_topup_velocity'], context: { creditedOrders: counts.rows[0].n, windowMinutes } };
        await write(client, systemFingerprint(), event);
      }
    }
    await client.query('RELEASE SAVEPOINT topup_risk');
    return event;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT topup_risk');
    await client.query('RELEASE SAVEPOINT topup_risk');
    res.locals.log?.error({ err: error, requestId: res.locals.requestId }, 'Failed to assess credited top-ups');
  }
}
