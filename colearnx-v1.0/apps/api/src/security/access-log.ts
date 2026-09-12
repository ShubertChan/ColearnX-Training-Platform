import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../lib/http.js';
import { recordSecurityEvent, securityContext } from './events.js';

/**
 * Records every access-control and throttling decision (ASVS 7.2.2).
 *
 * This lives in its own middleware rather than inside errorHandler for a
 * dependency reason, not a stylistic one. The first version put it in
 * lib/http.ts, which made that module import security/events.ts, which imports
 * config/env.ts -- so every file that merely wanted `ApiError` suddenly
 * required a fully configured environment to load, and three unit tests that
 * had never needed one started failing.
 *
 * lib/http.ts is a leaf: ApiError, ok and errorHandler are used almost
 * everywhere, so anything it imports becomes a universal dependency. Keeping
 * the ledger out of it means telemetry can grow without dragging the whole
 * codebase behind it.
 *
 * Registered immediately before errorHandler, which still produces the
 * response. This middleware only observes and passes the error along.
 */
export function recordAccessDecision(error: unknown, req: Request, res: Response, next: NextFunction) {
  const status = error instanceof ApiError
    ? error.status
    : (error as { status?: number } | null)?.status;

  if (status === 403 || status === 429) {
    const code = error instanceof ApiError
      ? error.code
      : (error as { code?: string } | null)?.code ?? 'UNKNOWN';
    const actorId = typeof res.locals.actor?.id === 'string' ? res.locals.actor.id : null;
    // Detached: the ledger must never delay or fail an error response.
    // recordSecurityEvent already absorbs its own failures.
    void recordSecurityEvent(securityContext(req, res), {
      type: status === 429 ? 'access.rate_limited' : 'access.forbidden',
      actorUserId: actorId,
      decision: 'deny',
      context: { code, method: req.method, route: req.path },
    }, res);
  }

  return next(error);
}
