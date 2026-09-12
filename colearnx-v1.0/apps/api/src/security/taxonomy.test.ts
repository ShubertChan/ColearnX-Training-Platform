import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultSeverity, sanitiseContext, securityEventSeverity } from './taxonomy.js';

test('every event type has a severity in range', () => {
  for (const [type, severity] of Object.entries(securityEventSeverity)) {
    assert.ok(Number.isInteger(severity) && severity >= 0 && severity <= 4, `${type} -> ${severity}`);
  }
});

test('refresh token replay is the most severe event defined', () => {
  assert.equal(defaultSeverity('session.refresh_reused'), 4);
});

test('a routine failed login does not page an operator', () => {
  // Alerting fires at 3. A single wrong password must stay below it.
  assert.ok(defaultSeverity('auth.login_failed') < 3);
});

test('secret-bearing keys are dropped from context', () => {
  const output = sanitiseContext({
    password: 'hunter2',
    refreshToken: 'abc',
    csrfToken: 'def',
    apiKey: 'ghi',
    sessionId: 'jkl',
    authorization: 'Bearer x',
    reason: 'invalid',
  });
  assert.deepEqual(output, { reason: 'invalid' });
});

test('raw identifiers are dropped in favour of fingerprints', () => {
  const output = sanitiseContext({ email: 'a@b.com', ip: '203.0.113.7', userAgent: 'curl', subject: 'abc123' });
  assert.deepEqual(output, { subject: 'abc123' });
});

test('long strings are truncated rather than stored whole', () => {
  const output = sanitiseContext({ note: 'x'.repeat(5000) }) as { note: string };
  assert.ok(output.note.length <= 201);
});

test('nesting is capped so row size stays predictable', () => {
  const output = sanitiseContext({ a: { b: { c: { d: 1 } } } }) as Record<string, any>;
  assert.deepEqual(output.a.b, {});
});

test('an oversized context collapses to a summary instead of a huge row', () => {
  const wide: Record<string, unknown> = {};
  for (let index = 0; index < 20; index += 1) wide[`field${index}`] = 'y'.repeat(200);
  const output = sanitiseContext(wide) as { truncated?: boolean };
  assert.equal(output.truncated, true);
});

test('dates are serialised rather than dropped', () => {
  const at = new Date('2026-09-12T00:00:00.000Z');
  assert.deepEqual(sanitiseContext({ lockedUntil: at }), { lockedUntil: at.toISOString() });
});

test('values are matched by key name, never by content', () => {
  // A legitimate field whose value merely looks secret must survive.
  assert.deepEqual(sanitiseContext({ reason: 'token_expired' }), { reason: 'token_expired' });
});
