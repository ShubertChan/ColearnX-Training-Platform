import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerLifecycle, readIdleExitSeconds } from '../src/lifecycle.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<Parameters<typeof createWorkerLifecycle>[0]> = {}) {
  let time = 0;
  const events: string[] = [];
  const lifecycle = createWorkerLifecycle({
    idleExitMs: 120_000,
    now: () => time,
    hasPendingJobs: async () => { events.push('probe'); return false; },
    drainWorkers: async () => { events.push('drain'); },
    stopQueue: async () => { events.push('queue-closed'); },
    closeResources: async () => { events.push('resources-closed'); },
    onDraining: (reason) => { events.push(reason); },
    ...overrides,
  });
  return { lifecycle, events, advance: (ms: number) => { time += ms; } };
}

test('idle configuration preserves continuous mode and rejects unsafe/ambiguous values', () => {
  assert.equal(readIdleExitSeconds(undefined), 0);
  for (const value of ['0', '30', '120', '86400']) assert.equal(readIdleExitSeconds(value), Number(value));
  for (const value of ['', ' ', '-1', '1', '29', '01', '30.5', '120s', 'Infinity', 'NaN', '86401']) {
    assert.throws(() => readIdleExitSeconds(value), /VIDEO_WORKER_IDLE_EXIT_SECONDS/);
  }
});

test('continuous mode never probes or exits for idle time', async () => {
  const f = fixture({ idleExitMs: 0 });
  f.advance(1_000_000);
  await f.lifecycle.checkIdle();
  assert.deepEqual(f.events, []);
  assert.equal(f.lifecycle.isRunning(), true);
});

test('empty queue exits only after the full idle interval and closes in order', async () => {
  const f = fixture();
  f.advance(119_999);
  await f.lifecycle.checkIdle();
  assert.deepEqual(f.events, []);
  f.advance(1);
  await f.lifecycle.checkIdle();
  assert.deepEqual(f.events, ['probe', 'idle', 'drain', 'queue-closed', 'resources-closed']);
  await f.lifecycle.checkIdle();
  assert.equal(f.events.length, 5);
});

test('queued, delayed retry or active work keeps the batch running', async () => {
  let pending = true;
  let probes = 0;
  const f = fixture({ hasPendingJobs: async () => { probes += 1; return pending; } });
  f.advance(120_000);
  await f.lifecycle.checkIdle();
  assert.equal(f.lifecycle.isRunning(), true);
  pending = false;
  f.advance(119_999);
  await f.lifecycle.checkIdle();
  assert.equal(probes, 1);
  f.advance(1);
  await f.lifecycle.checkIdle();
  assert.equal(f.lifecycle.isRunning(), false);
});

test('a long active task cannot be cut off by idle exit; idle restarts after completion', async () => {
  const f = fixture();
  const work = deferred();
  const task = f.lifecycle.runTask(() => work.promise);
  f.advance(7_200_000);
  await f.lifecycle.checkIdle();
  assert.deepEqual(f.events, []);
  work.resolve();
  await task;
  await f.lifecycle.checkIdle();
  assert.deepEqual(f.events, []);
  f.advance(120_000);
  await f.lifecycle.checkIdle();
  assert.equal(f.lifecycle.isRunning(), false);
});

test('failed work still releases the active counter and starts a new idle window', async () => {
  const f = fixture();
  await assert.rejects(f.lifecycle.runTask(async () => { throw new Error('transcode failed'); }));
  f.advance(120_000);
  await f.lifecycle.checkIdle();
  assert.equal(f.lifecycle.isRunning(), false);
});

test('periodic maintenance does not keep an otherwise idle batch awake indefinitely', async () => {
  const f = fixture({ idleExitMs: 600_000 });
  for (let i = 0; i < 2; i += 1) {
    f.advance(300_000);
    await f.lifecycle.runTask(async () => {}, false);
  }
  await f.lifecycle.checkIdle();
  assert.equal(f.lifecycle.isRunning(), false);
});

test('database errors are not treated as an empty queue', async () => {
  const f = fixture({ hasPendingJobs: async () => { throw new Error('offline'); } });
  f.advance(120_000);
  await assert.rejects(f.lifecycle.checkIdle(), /offline/);
  assert.equal(f.lifecycle.isRunning(), true);
  assert.deepEqual(f.events, []);
});

test('overlapping idle checks share one pending database probe', async () => {
  const probe = deferred<boolean>();
  let probes = 0;
  const f = fixture({ hasPendingJobs: () => { probes += 1; return probe.promise; } });
  f.advance(120_000);
  const first = f.lifecycle.checkIdle();
  assert.equal(first, f.lifecycle.checkIdle());
  probe.resolve(false);
  await first;
  assert.equal(probes, 1);
  assert.equal(f.events.filter((value) => value === 'drain').length, 1);
});

test('work that starts and finishes during an idle probe invalidates the stale result', async () => {
  const probe = deferred<boolean>();
  const f = fixture({ hasPendingJobs: () => probe.promise });
  f.advance(120_000);
  const checking = f.lifecycle.checkIdle();
  await f.lifecycle.runTask(async () => {});
  probe.resolve(false);
  await checking;
  assert.equal(f.lifecycle.isRunning(), true);
  assert.deepEqual(f.events, []);
});

test('signals are idempotent and wait for the job acknowledgement and maintenance', async () => {
  const acknowledgement = deferred();
  const maintenance = deferred();
  const f = fixture({ drainWorkers: () => acknowledgement.promise });
  const task = f.lifecycle.runTask(() => maintenance.promise, false);
  const stopping = f.lifecycle.stop('SIGTERM');
  assert.equal(stopping, f.lifecycle.stop('SIGINT'));
  await Promise.resolve();
  acknowledgement.resolve();
  await Promise.resolve();
  assert.deepEqual(f.events, ['SIGTERM']);
  maintenance.resolve();
  await task;
  await stopping;
  assert.deepEqual(f.events, ['SIGTERM', 'queue-closed', 'resources-closed']);
});

test('a claimed job delivered while draining finishes before resources close', async () => {
  const fetchedJob = deferred();
  const f = fixture({ drainWorkers: () => fetchedJob.promise });
  const stopping = f.lifecycle.stop('SIGTERM');
  const job = deferred();
  const task = f.lifecycle.runTask(() => job.promise);
  fetchedJob.resolve();
  await Promise.resolve();
  assert.equal(f.events.includes('resources-closed'), false);
  job.resolve();
  await task;
  await stopping;
  assert.equal(f.events.at(-1), 'resources-closed');
});

test('queue-close failure still closes other resources and remains a failure', async () => {
  const f = fixture({ stopQueue: async () => { throw new Error('close failed'); } });
  await assert.rejects(f.lifecycle.stop('SIGTERM'), /close failed/);
  assert.equal(f.events.at(-1), 'resources-closed');
});
