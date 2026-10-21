import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, mock, test } from 'node:test';
import type { Request, Response } from 'express';
import type { Client, PoolClient } from 'pg';

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret-that-is-long-enough';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret-that-is-long-enough';
process.env.CSRF_SECRET = 'test-csrf-secret-that-is-long-enough';
const { pool } = await import('../db/database.js');
const { acknowledgeRefundNotification, listRefundNotifications, recordRefundNotification } = await import('./notifications.js');
const { createRefundNotificationEvents, refundNotificationEvents, refundNotificationChannel } = await import('./notification-events.js');
const { decideRefund } = await import('./service.js');
const owner = '10000000-0000-4000-8000-000000000001';
const id = '10000000-0000-4000-8000-000000000002';
const refund = '10000000-0000-4000-8000-000000000003';
const row = { notification_id: id, refund_request_id: refund, refund_status: 'rejected', title: 'Course', message: 'Refund limit exceeded', requested_points: '100', order_id: 'order', created_at: new Date() };
function response() {
  return Object.assign(new EventEmitter(), { locals: { actor: { id: owner } }, destroyed: false,
    status() { return this; }, json(body: unknown) { return body; } }) as unknown as Response;
}
const request = (wait = false) => ({ query: wait ? { wait: '1' } : {}, params: { id } }) as unknown as Request;
afterEach(() => mock.restoreAll());

test('unread reads are owner-scoped and do not mark notifications read', async () => {
  const queried = mock.method(pool, 'query', async (sql: string, values: unknown[]) => {
    assert.match(sql, /n.user_id = \$1 AND rr.requested_by_user_id = \$1/);
    assert.match(sql, /n.is_read = false/);
    assert.match(sql, /ORDER BY n.created_at ASC, n.notification_id ASC LIMIT 20/);
    assert.deepEqual(values, [owner]);
    return { rows: [row] };
  });
  const result = await listRefundNotifications(request(), response()) as unknown as { data: { points: number; status: string }[] };
  assert.equal(result.data[0].points, 100);
  assert.equal(result.data[0].status, 'rejected');
  assert.equal(queried.mock.callCount(), 1);
});

test('acknowledgement is owner-scoped, repeatable, and rejects another user’s ID', async () => {
  let found = true;
  mock.method(pool, 'query', async (sql: string, values: unknown[]) => {
    assert.match(sql, /notification_id = \$1 AND user_id = \$2/);
    assert.match(sql, /read_at = COALESCE\(read_at, now\(\)\)/);
    assert.deepEqual(values, [id, owner]);
    return { rowCount: found ? 1 : 0 };
  });
  await acknowledgeRefundNotification(request(), response());
  await acknowledgeRefundNotification(request(), response());
  found = false;
  await assert.rejects(() => acknowledgeRefundNotification(request(), response()), { code: 'NOTIFICATION_NOT_FOUND' });
});

test('long poll subscribes before reading and wakes on a decision committed during the read', async () => {
  let subscribed = false, wake!: () => void, reads = 0, disposed = false;
  mock.method(refundNotificationEvents, 'subscribe', (userId: string, callback: () => void) => {
    assert.equal(userId, owner); subscribed = true; wake = callback;
    return { ready: Promise.resolve(true), dispose() { disposed = true; } };
  });
  mock.method(pool, 'query', async () => {
    assert.ok(subscribed);
    if (++reads === 1) { wake(); return { rows: [] }; }
    return { rows: [row] };
  });
  const res = response();
  const result = await listRefundNotifications(request(true), res) as unknown as { data: unknown[] };
  assert.equal(result.data.length, 1);
  assert.ok(disposed);
  assert.equal(res.listenerCount('close'), 0);
});

test('closing the HTTP connection cancels a pending wait and removes its subscription', async () => {
  let disposed = false;
  mock.method(refundNotificationEvents, 'subscribe', () => ({ ready: Promise.resolve(true), dispose() { disposed = true; } }));
  const res = response();
  mock.method(pool, 'query', async () => {
    Object.assign(res, { destroyed: true }); res.emit('close'); return { rows: [] };
  });
  assert.equal(await listRefundNotifications(request(true), res), undefined);
  assert.ok(disposed);
});

test('LISTEN failure falls back to durable reads without dropping an offline decision', async () => {
  let reads = 0;
  mock.method(refundNotificationEvents, 'subscribe', () => ({ ready: Promise.resolve(false), dispose() {} }));
  mock.method(pool, 'query', async () => ({ rows: ++reads === 1 ? [] : [row] }));
  const result = await listRefundNotifications(request(true), response()) as unknown as { data: unknown[] };
  assert.equal(result.data.length, 1);
  assert.equal(reads, 2);
});

test('duplicate notification recording does not send a second wake event', async () => {
  const calls: string[] = [];
  const client = { async query(sql: string) { calls.push(sql); return { rowCount: 0 }; } } as unknown as PoolClient;
  await recordRefundNotification(client, { userId: owner, refundRequestId: refund, title: 'Course', reason: 'Refund approved' });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /ON CONFLICT \(refund_request_id\) DO NOTHING/);
});

for (const decision of ['approved', 'rejected']) {
  for (const failNotification of [false, true]) {
    test(`${decision} decision and notification share a transaction (${failNotification ? 'rollback' : 'commit'})`, async () => {
      const statements: string[] = [];
      const client = {
        release() {},
        async query(sql: string, values: unknown[] = []) {
          statements.push(sql);
          if (sql.includes("account_status = 'system'")) return { rows: [{ point_account_id: 'system' }], rowCount: 1 };
          if (sql.includes('FOR UPDATE OF rr, oi, pa')) return { rows: [{ refund_request_id: refund, refund_status: 'pending', requested_by_user_id: owner, requested_points: '0', eligibility_snapshot_json: { eligible: true }, fulfilment_status: 'fulfilled', item_title_snapshot: 'Course' }], rowCount: 1 };
          if (sql.includes('INSERT INTO notifications')) {
            assert.deepEqual(values, [owner, 'Course', 'Reviewed request', refund]);
            if (failNotification) throw new Error('Notification insert failed');
            return { rowCount: 1 };
          }
          if (sql.includes('pg_notify')) assert.deepEqual(values, [refundNotificationChannel, owner]);
          return { rows: [], rowCount: 0 };
        },
      };
      mock.method(pool, 'connect', async () => client);
      const req = { params: { id: refund }, body: { decision, reason: 'Reviewed request' } } as unknown as Request;
      if (failNotification) await assert.rejects(() => decideRefund(req, response()), /Notification insert failed/);
      else await decideRefund(req, response());
      assert.equal(statements[0], 'BEGIN');
      assert.equal(statements.at(-1), failNotification ? 'ROLLBACK' : 'COMMIT');
      assert.ok(statements.some(sql => sql.includes('UPDATE refund_requests SET refund_status')));
      assert.equal(statements.some(sql => sql.includes('pg_notify')), !failNotification);
    });
  }
}

class FakeClient extends EventEmitter {
  commands: string[] = [];
  failed = false;
  async connect() { if (this.failed) throw new Error('Disconnected'); }
  async query(sql: string) { this.commands.push(sql); }
  async end() { this.emit('end'); }
}

test('one listener connection serves multiple users, filters owners, reconnects and disposes', async () => {
  const clients: FakeClient[] = [];
  const events = createRefundNotificationEvents(() => { const client = new FakeClient(); clients.push(client); return client as unknown as Client; });
  let first = 0, second = 0;
  const one = events.subscribe(owner, () => first++);
  const two = events.subscribe('other', () => second++);
  assert.deepEqual(await Promise.all([one.ready, two.ready]), [true, true]);
  assert.equal(clients.length, 1);
  assert.deepEqual(clients[0].commands, [`LISTEN ${refundNotificationChannel}`]);
  clients[0].emit('notification', { channel: refundNotificationChannel, payload: owner });
  assert.equal(first, 1); assert.equal(second, 0);
  one.dispose();
  clients[0].emit('notification', { channel: refundNotificationChannel, payload: owner });
  assert.equal(first, 1);
  clients[0].emit('error', new Error('Connection lost'));
  assert.equal(second, 1);
  const next = events.subscribe('other', () => second++);
  assert.equal(await next.ready, true);
  assert.equal(clients.length, 2);
  two.dispose(); next.dispose();
  await events.close();
});

test('listener startup failure releases waiters and allows a later reconnect', async () => {
  let attempts = 0, wakes = 0;
  const events = createRefundNotificationEvents(() => { const client = new FakeClient(); client.failed = attempts++ === 0; return client as unknown as Client; });
  const first = events.subscribe(owner, () => wakes++);
  assert.equal(await first.ready, false);
  assert.equal(wakes, 1);
  first.dispose();
  const second = events.subscribe(owner, () => wakes++);
  assert.equal(await second.ready, true);
  await events.close();
  assert.equal(wakes, 2);
});
