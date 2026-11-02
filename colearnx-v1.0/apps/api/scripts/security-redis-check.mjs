// CI service only. Use a unique expiring key on loopback, never a developer's REDIS_URL.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import express from 'express';
import rateLimit from 'express-rate-limit';
import request from 'supertest';
import { RedisRateLimitStore } from '../src/security/rate-limit-store.ts';
import { dedupeWindowMs, makeAlertDeduper } from '../src/security/alert-dedupe.ts';

const bucket = 'w9-' + randomUUID();
const port = Number(process.env.W9_TEST_REDIS_PORT ?? 6379);
assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
const clients = [0, 1].map(() => new Redis({ host: '127.0.0.1', port, db: 15, lazyConnect: true,
  maxRetriesPerRequest: 0, retryStrategy: () => null, connectTimeout: 3000 }));
try {
  await Promise.all(clients.map(c => c.connect()));
  const replicas = clients.map(c => {
    const app = express();
    app.use(rateLimit({ windowMs: 60000, limit: 2, keyGenerator: () => 'test-source', store: new RedisRateLimitStore(c, bucket) }));
    app.get('/', (_req, res) => res.sendStatus(200));
    return app;
  });
  await request(replicas[0]).get('/').expect(200);
  await request(replicas[1]).get('/').expect(200);
  await request(replicas[0]).get('/').expect(429);
  const key = 'rl:' + bucket + ':test-source';
  assert.equal(await clients[1].get(key), '3');
  assert.ok(await clients[1].pttl(key) > 0);
  console.log('PASS W5: two API limiters share one expiring Redis quota');
  const dedupers = clients.map(c => makeAlertDeduper(() => c));
  const alert = { type: 'finance.ledger_imbalance', severity: 4, actorUserId: randomUUID(), requestId: null, context: {} };
  const winners = await Promise.all(dedupers.map(shouldSend => shouldSend(alert, Date.now())));
  assert.equal(winners.filter(Boolean).length, 1);
  const ttl = await clients[0].pttl('alert-dedup:' + alert.type + ':' + alert.actorUserId);
  assert.ok(ttl > 0 && ttl <= dedupeWindowMs);
  assert.equal(await dedupers[0]({ ...alert, actorUserId: randomUUID() }, Date.now()), true);
  console.log('PASS W6: only one replica may send a duplicate alert; an unrelated account still alerts');
} finally { for (const c of clients) c.disconnect(); }
