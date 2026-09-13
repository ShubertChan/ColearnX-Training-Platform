import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { reserveIdempotency } from './idempotency.js';

const input = { actorUserId: '11111111-1111-4111-8111-111111111111', operationScope: 'test.operation', key: 'stable-key', fingerprint: 'abc' };

test('a claimed idempotency key proceeds with business work', async () => {
  const client = { query: async () => ({ rowCount: 1, rows: [{}] }) } as unknown as PoolClient;
  assert.equal(await reserveIdempotency(client, input), null);
});

test('a completed matching idempotency record replays its original response', async () => {
  let calls = 0;
  const client = { query: async () => {
    calls += 1;
    return calls === 1 ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ request_fingerprint: 'abc', response_body: { id: 'report-1' } }] };
  } } as unknown as PoolClient;
  assert.deepEqual(await reserveIdempotency(client, input), { id: 'report-1' });
});

test('a matching unfinished or mismatched request cannot be treated as a new write', async () => {
  const fixture = (fingerprint: string, responseBody: unknown) => {
    let calls = 0;
    return { query: async () => {
      calls += 1;
      return calls === 1 ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ request_fingerprint: fingerprint, response_body: responseBody }] };
    } } as unknown as PoolClient;
  };
  await assert.rejects(reserveIdempotency(fixture('different', { id: 'other' }), input), { status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(reserveIdempotency(fixture('abc', null), input), { status: 409, code: 'REQUEST_IN_PROGRESS' });
});
