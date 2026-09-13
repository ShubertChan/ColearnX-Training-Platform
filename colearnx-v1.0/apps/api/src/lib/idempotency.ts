import type { PoolClient } from 'pg';
import { ApiError } from './http.js';

type IdempotencyInput = {
  actorUserId: string;
  operationScope: string;
  key: string;
  fingerprint: string;
};

/**
 * Reserves an idempotency key inside the caller's business transaction.
 *
 * `INSERT ... ON CONFLICT DO NOTHING` is deliberate: a read-then-insert
 * sequence races under concurrent first submissions and leaks PostgreSQL's
 * unique-constraint error as a 500. PostgreSQL waits for a competing insert to
 * finish before deciding whether this statement conflicts, so the subsequent
 * locked read sees either its completed response or a legacy incomplete row.
 */
export async function reserveIdempotency<T>(client: PoolClient, input: IdempotencyInput): Promise<T | null> {
  const inserted = await client.query(
    `INSERT INTO idempotency_records (actor_user_id, operation_scope, idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (actor_user_id, operation_scope, idempotency_key) DO NOTHING
     RETURNING idempotency_record_id`,
    [input.actorUserId, input.operationScope, input.key, input.fingerprint],
  );
  if (inserted.rowCount) return null;

  const existing = await client.query<{ request_fingerprint: string; response_body: T | null }>(
    `SELECT request_fingerprint, response_body
       FROM idempotency_records
      WHERE actor_user_id = $1 AND operation_scope = $2 AND idempotency_key = $3
      FOR UPDATE`,
    [input.actorUserId, input.operationScope, input.key],
  );
  if (!existing.rowCount) {
    throw new ApiError(409, 'REQUEST_IN_PROGRESS', 'The matching request is still processing.');
  }
  if (existing.rows[0].request_fingerprint !== input.fingerprint) {
    throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different request.');
  }
  if (existing.rows[0].response_body === null) {
    throw new ApiError(409, 'REQUEST_IN_PROGRESS', 'The matching request is still processing.');
  }
  return existing.rows[0].response_body;
}

export async function completeIdempotency(
  client: PoolClient,
  input: IdempotencyInput,
  status: number,
  body: unknown,
) {
  await client.query(
    `UPDATE idempotency_records
        SET response_status = $5, response_body = $6::jsonb, completed_at = now()
      WHERE actor_user_id = $1 AND operation_scope = $2 AND idempotency_key = $3
        AND request_fingerprint = $4`,
    [input.actorUserId, input.operationScope, input.key, input.fingerprint, status, JSON.stringify(body)],
  );
}
