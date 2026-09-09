import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://colearnx:password@localhost:5432/colearnx';
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret-at-least-32-characters';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret-at-least-32-characters';
process.env.CSRF_SECRET = 'test-csrf-secret-at-least-32-characters';
process.env.EMAIL_PROVIDER = 'resend';
process.env.RESEND_API_KEY = 're_test';
process.env.EMAIL_FROM = 'CoLearnX <noreply@example.test>';
process.env.EMAIL_VERIFICATION_CODE_PEPPER = 'test-email-verification-pepper-at-least-32-characters';

const { resumePendingRegistration } = await import('./auth.js');

type QueryResponse = Array<Record<string, unknown>>;

function clientWith(responses: QueryResponse[]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      const rows = responses.shift() ?? [];
      return { rows, rowCount: rows.length };
    },
  } as unknown as PoolClient;
  return { client, calls };
}

const pendingUser = {
  id: '1c5a3ce6-cf5d-4b46-8b74-b5c8235aaf6e',
  email: 'member@example.com',
  status: 'active',
  email_verified_at: null,
  email_verification_required_at: new Date('2026-09-09T00:00:00.000Z'),
};

test('a repeat registration reuses a valid pending verification code', async () => {
  const { client, calls } = clientWith([
    [pendingUser],
    [{ expires_at: new Date(Date.now() + 60_000), resend_available_at: new Date(Date.now() + 30_000), failed_attempts: 0 }],
  ]);

  const outcome = await resumePendingRegistration(client, pendingUser.email);

  assert.equal(outcome.kind, 'reuse');
  assert.equal(outcome.email, pendingUser.email);
  assert.equal(calls.length, 2);
});

test('an expired or locked pending verification code is replaced', async () => {
  for (const challenge of [
    { expires_at: new Date(Date.now() - 1), resend_available_at: new Date(Date.now() - 1), failed_attempts: 0 },
    { expires_at: new Date(Date.now() + 60_000), resend_available_at: new Date(Date.now() + 30_000), failed_attempts: 5 },
  ]) {
    const { client, calls } = clientWith([[pendingUser], [challenge], []]);
    const outcome = await resumePendingRegistration(client, pendingUser.email);

    assert.equal(outcome.kind, 'send');
    assert.equal(outcome.challenge.userId, pendingUser.id);
    assert.match(calls[2].text, /ON CONFLICT \(user_id\) DO UPDATE/);
  }
});

test('a verified or unavailable account cannot resume registration', async () => {
  const { client, calls } = clientWith([[
    { ...pendingUser, email_verified_at: new Date('2026-09-09T00:01:00.000Z') },
  ]]);

  assert.deepEqual(await resumePendingRegistration(client, pendingUser.email), { kind: 'conflict' });
  assert.equal(calls.length, 1);
});
