import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAlertDeduper } from './alert-dedupe.js';
import type { SecurityAlert } from './alerts.js';

const windowMs = 5 * 60 * 1000;
const alert = (actor: string | null = 'user-1'): SecurityAlert => ({
  type: 'access.rate_limited',
  severity: 3,
  actorUserId: actor,
  requestId: null,
  context: {},
});

test('no redis: the per-process map suppresses repeats inside the window', async () => {
  const shouldSend = makeAlertDeduper(() => null);
  assert.equal(await shouldSend(alert(), 1_000), true);
  assert.equal(await shouldSend(alert(), 2_000), false);
  assert.equal(await shouldSend(alert(), 1_000 + windowMs + 1), true);
});

test('no redis: different actors are deduplicated independently', async () => {
  const shouldSend = makeAlertDeduper(() => null);
  assert.equal(await shouldSend(alert('a'), 0), true);
  assert.equal(await shouldSend(alert('b'), 0), true);
});

test('redis: only the first caller inside the window sends (SET NX)', async () => {
  const seen = new Set<string>();
  const fake = {
    async set(key: string) {
      if (seen.has(key)) return null;
      seen.add(key);
      return 'OK';
    },
  };
  const shouldSend = makeAlertDeduper(() => fake as never);
  assert.equal(await shouldSend(alert(), 0), true);
  assert.equal(await shouldSend(alert(), 0), false);
});

test('redis error falls back to the map and never silently drops an alert', async () => {
  const fake = { async set() { throw new Error('redis down'); } };
  const shouldSend = makeAlertDeduper(() => fake as never);
  // First call: Redis throws, fallback map records and allows the send.
  assert.equal(await shouldSend(alert(), 0), true);
  // Immediate repeat is then suppressed by the fallback map, not lost.
  assert.equal(await shouldSend(alert(), 1), false);
});
