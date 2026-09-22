import test from 'node:test';
import assert from 'node:assert/strict';
import type { Options } from 'express-rate-limit';
import { RedisRateLimitStore, type RateLimitRedis } from './rate-limit-store.js';

function fakeRedis() {
  const counters = new Map<string, number>();
  const ttls = new Map<string, number>();
  const api = {
    fail: false,
    async incr(key: string) { if (api.fail) throw new Error('down'); const n = (counters.get(key) ?? 0) + 1; counters.set(key, n); return n; },
    async decr(key: string) { if (api.fail) throw new Error('down'); const n = (counters.get(key) ?? 0) - 1; counters.set(key, n); return n; },
    async pexpire(key: string, ms: number) { if (api.fail) throw new Error('down'); ttls.set(key, ms); return 1; },
    async pttl(key: string) { if (api.fail) throw new Error('down'); return ttls.get(key) ?? -1; },
    async del(key: string) { if (api.fail) throw new Error('down'); counters.delete(key); ttls.delete(key); return 1; },
  };
  return { api: api as RateLimitRedis & { fail: boolean }, counters, ttls };
}

const options = { windowMs: 60_000 } as unknown as Options;

test('increment shares one counter per key and reports a future reset time', async () => {
  const { api } = fakeRedis();
  const store = new RedisRateLimitStore(api, 'auth');
  store.init(options);
  const first = await store.increment('1.2.3.4');
  assert.equal(first.totalHits, 1);
  assert.ok((first.resetTime?.getTime() ?? 0) > Date.now());
  assert.equal((await store.increment('1.2.3.4')).totalHits, 2);
  // A different key is an independent budget.
  assert.equal((await store.increment('9.9.9.9')).totalHits, 1);
});

test('only the first hit arms the expiry window', async () => {
  const { api, ttls } = fakeRedis();
  const store = new RedisRateLimitStore(api, 'auth');
  store.init(options);
  await store.increment('k');
  await store.increment('k');
  assert.equal(ttls.get('rl:auth:k'), 60_000);
});

test('a missing expiry is re-armed rather than left without a reset time', async () => {
  const { api, ttls } = fakeRedis();
  const store = new RedisRateLimitStore(api, 'auth');
  store.init(options);
  await store.increment('k');
  ttls.delete('rl:auth:k'); // simulate a key that lost its TTL
  const again = await store.increment('k');
  assert.ok((again.resetTime?.getTime() ?? 0) > Date.now());
  assert.equal(ttls.get('rl:auth:k'), 60_000);
});

test('increment fails open (0 hits => allowed) when redis is unreachable', async () => {
  const { api } = fakeRedis();
  api.fail = true;
  const store = new RedisRateLimitStore(api, 'auth');
  store.init(options);
  assert.equal((await store.increment('k')).totalHits, 0);
});

test('decrement and resetKey never throw even when redis is down', async () => {
  const { api } = fakeRedis();
  api.fail = true;
  const store = new RedisRateLimitStore(api, 'auth');
  store.init(options);
  await store.decrement('k');
  await store.resetKey('k');
});
