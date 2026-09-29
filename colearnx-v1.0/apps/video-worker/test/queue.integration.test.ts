import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { PgBoss } from 'pg-boss';
import { Pool } from 'pg';
import { createWorkerLifecycle, pendingTranscodeSql } from '../src/lifecycle.js';
import { createVideoQueueProducer, videoQueueProducerOptions } from '../../api/src/video/queue-producer.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const connectionString = process.env.COLEARNX_QUEUE_TEST_URL;
test('isolated PostgreSQL: producer closes, deferred jobs persist, shutdown drains acknowledgements',
  { skip: !connectionString, timeout: 45_000 }, async (t) => {
    // Never accept the application's normal DATABASE_URL or a cloud host.
    const target = new URL(connectionString!);
    assert.equal(target.hostname, '127.0.0.1');
    assert.match(target.pathname, /^\/colearnx_queue_test_[a-z0-9_]+$/);
    const pool = new Pool({ connectionString });
    const name = 'course-video.transcode';
    const options = videoQueueProducerOptions(connectionString!);
    const admin = new PgBoss({ ...options, migrate: true, createSchema: true });
    const errors: string[] = [];
    const clients: PgBoss[] = [];
    let statements = 0;
    const producer = createVideoQueueProducer(() => {
      const queue = new PgBoss({ ...options, application_name: 'batch-test-producer', queueCacheIntervalSeconds: 1 });
      const db = queue.getDb();
      const execute = db.executeSql.bind(db);
      db.executeSql = async (...args) => { statements += 1; return execute(...args); };
      clients.push(queue);
      return queue;
    }, (event) => { errors.push(event); });
    const worker = new PgBoss({ ...options, application_name: 'batch-test-worker' });
    admin.on('error', () => errors.push('admin queue error'));
    worker.on('error', () => errors.push('worker queue error'));
    let lifecycle: ReturnType<typeof createWorkerLifecycle> | undefined;
    const release = deferred();
    try {
      await admin.start();
      await admin.createQueue(name, { retryLimit: 5, retryDelay: 30, expireInSeconds: 21600, heartbeatSeconds: 60 });
      await admin.stop();
      const hasPending = async () => Boolean((await pool.query(pendingTranscodeSql, [name])).rows[0].pending);

      await t.test('producer closes every concurrent client and stops its queue-cache SQL timer', async () => {
        const ids = await Promise.all([producer.enqueue(randomUUID()), producer.enqueue(randomUUID())]);
        assert.ok(ids.every(Boolean));
        assert.equal(new Set(ids).size, 2);
        assert.equal(clients.length, 2);
        const before = statements;
        await delay(1_250);
        assert.equal(statements, before, 'no queue-cache queries after producer finishes');
        const connections = await pool.query(`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'batch-test-producer'`);
        assert.equal(connections.rows[0].count, 0);
        assert.equal(await hasPending(), true, 'closing a producer must not delete its durable jobs');
        await pool.query(`UPDATE pgboss.job SET state = 'completed' WHERE name = $1`, [name]);
      });

      await t.test('direct idle check includes delayed retries, but ignores terminal jobs', async () => {
        const id = await producer.enqueue(randomUUID());
        await pool.query(`UPDATE pgboss.job SET state = 'retry', start_after = now() + interval '1 hour' WHERE id = $1`, [id]);
        assert.equal(await hasPending(), true);
        await pool.query(`UPDATE pgboss.job SET state = 'failed' WHERE id = $1`, [id]);
        assert.equal(await hasPending(), false);
      });

      const id = await producer.enqueue(randomUUID());
      await worker.start();
      const started = deferred();
      const events: string[] = [];
      lifecycle = createWorkerLifecycle({ idleExitMs: 120_000, hasPendingJobs: hasPending,
        onDraining: () => { events.push('draining'); },
        drainWorkers: () => worker.offWork(name, { wait: true }),
        stopQueue: () => worker.stop(),
        closeResources: async () => { events.push('closed'); },
      });
      await worker.work(name, { pollingIntervalSeconds: 0.5 }, async () => lifecycle!.runTask(async () => {
        started.resolve();
        await release.promise;
      }));
      await started.promise;

      await t.test('signal waits for a real active handler and pg-boss completion acknowledgement', async () => {
        const stopping = lifecycle!.stop('SIGTERM');
        await delay(100);
        assert.deepEqual(events, ['draining']);
        assert.equal((await pool.query('SELECT state FROM pgboss.job WHERE id = $1', [id])).rows[0].state, 'active');
        const next = await producer.enqueue(randomUUID());
        release.resolve();
        await stopping;
        assert.deepEqual(events, ['draining', 'closed']);
        assert.equal((await pool.query('SELECT state FROM pgboss.job WHERE id = $1', [id])).rows[0].state, 'completed');
        assert.equal((await pool.query('SELECT state FROM pgboss.job WHERE id = $1', [next])).rows[0].state, 'created', 'new jobs wait for the next batch');
        assert.equal((await pool.query(`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'batch-test-worker'`)).rows[0].count, 0);
      });

      await t.test('empty batch exits and a later batch can still accept jobs', async () => {
        await pool.query(`UPDATE pgboss.job SET state = 'completed' WHERE name = $1 AND state = 'created'`, [name]);
        const nextWorker = new PgBoss(options);
        nextWorker.on('error', () => errors.push('next worker error'));
        await nextWorker.start();
        let time = 0;
        const nextLifecycle = createWorkerLifecycle({ idleExitMs: 120_000, now: () => time, hasPendingJobs: hasPending,
          onDraining: () => {}, drainWorkers: () => nextWorker.offWork(name, { wait: true }),
          stopQueue: () => nextWorker.stop(), closeResources: async () => {},
        });
        try {
          time = 120_000;
          await nextLifecycle.checkIdle();
          assert.equal(nextLifecycle.isRunning(), false);
          assert.ok(await producer.enqueue(randomUUID()));
          assert.equal(await hasPending(), true);
        } finally { await nextWorker.stop(); }
      });
      assert.deepEqual(errors, []);
    } finally {
      release.resolve();
      await producer.close();
      await worker.stop();
      await admin.stop();
      await pool.end();
    }
  });
