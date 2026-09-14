import { z, type ZodType } from 'zod';
import { ApiError } from './http.js';

export const uuid = z.string().uuid();
export const idempotencyKey = z.string().trim().min(8).max(200);

export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'The request is invalid.', { issues: result.error.flatten() });
  return result.data;
}

