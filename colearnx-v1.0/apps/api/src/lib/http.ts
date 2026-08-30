import type { NextFunction, Request, Response } from 'express';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

export function ok<T>(res: Response, data: T, status = 200, meta: Record<string, unknown> = {}) {
  return res.status(status).json({ data, meta: { requestId: res.locals.requestId, ...meta } });
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  const known = error as { status?: number; code?: string };
  const apiError = error instanceof ApiError
    ? error
    : known.status === 429
      ? new ApiError(429, known.code ?? 'RATE_LIMITED', 'Too many requests. Please try again later.')
      : known.status === 503
        ? new ApiError(503, known.code ?? 'DEPENDENCY_UNAVAILABLE', 'A required service is temporarily unavailable.')
        : new ApiError(500, 'INTERNAL_ERROR', 'The service encountered an unexpected error.');
  if (!(error instanceof ApiError)) {
    res.locals.log?.error({ err: error, requestId: res.locals.requestId }, 'Unhandled API error');
  }
  return res.status(apiError.status).json({
    error: {
      code: apiError.code,
      message: apiError.message,
      details: apiError.details,
      requestId: res.locals.requestId,
    },
  });
}

export function notFound(req: Request, _res: Response, next: NextFunction) {
  next(new ApiError(404, 'NOT_FOUND', `No API route matches ${req.method} ${req.path}.`));
}
