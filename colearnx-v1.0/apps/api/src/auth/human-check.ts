import type { Request, RequestHandler, Response } from 'express';
import { env } from '../config/env.js';
import { ApiError, ok } from '../lib/http.js';
import { recordSecurityEvent, securityContext } from '../security/events.js';
import { verifyHumanToken, type HumanAction } from '../security/turnstile.js';

export const humanCheckConfig = (_req: Request, res: Response) =>
  ok(res, { enabled: Boolean(env.TURNSTILE_SITE_KEY), siteKey: env.TURNSTILE_SITE_KEY || null });

export const requireHumanCheck = (select: HumanAction | ((req: Request) => HumanAction)): RequestHandler => async (req, res, next) => {
  const action = typeof select === 'function' ? select(req) : select;
  const token = req.body?.turnstileToken;
  if (req.body) delete req.body.turnstileToken; // business schemas never receive the proof
  if (!env.TURNSTILE_SECRET_KEY) return next();
  try {
    await verifyHumanToken(token, action, env.TURNSTILE_SECRET_KEY, new URL(env.APP_ORIGIN).hostname);
  } catch (error) {
    await recordSecurityEvent(securityContext(req, res), {
      type: 'auth.human_check_failed', decision: 'challenge',
      context: { action, reason: error instanceof ApiError ? error.code : 'unavailable' },
    }, res);
    return next(error);
  }
  next();
};
