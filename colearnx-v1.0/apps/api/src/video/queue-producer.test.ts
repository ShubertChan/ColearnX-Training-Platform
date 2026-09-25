import assert from 'node:assert/strict';
import test from 'node:test';
import { createVideoQueueProducer, videoQueueProducerOptions } from './queue-producer.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function fakeQueue() {
  const calls: unknown[] = [];
  let listener: (() => void) | undefined;
  const queue = {
    on: (_event: 'error', callback: () => void) => { listener = callback; },
    start: async () => { calls.push('start'); },
    send: async (...args: unknown[]): Promise<string | null> => { calls.push(args); return 'job-id'; },
    stop: async () => { calls.push('stop'); },
  };
  return { queue, calls, emitError: () => listener?.() };
}

test('producer disables all optional background services and runtime DDL', () => {
  assert.deepEqual(videoQueueProducerOptions('postgresql://test'), {
    connectionString: 'postgresql://test', schema: 'pgboss', migrate: false, createSchema: false,
    supervise: false, schedule: false, useListenNotify: false, max: 1, connectionTimeoutMillis: 15_000,
  });
});

test('each accepted enqueue closes its client and retains retry/idempotency settings', async () => {
  const f = fakeQueue();
  const producer = createVideoQueueProducer(() => f.queue, () => {});
  assert.equal(await producer.enqueue('version-1'), 'job-id');
  assert.deepEqual(f.calls, ['start', ['course-video.transcode', { videoVersionId: 'version-1' }, {
    singletonKey: 'video-version:version-1', retryLimit: 5, retryDelay: 30, expireInSeconds: 21600,
  }], 'stop']);
});

test('failed partial startup closes the client and the next request uses a fresh one', async () => {
  const first = fakeQueue();
  first.queue.start = async () => { throw new Error('do not expose credential details'); };
  const second = fakeQueue();
  const clients = [first.queue, second.queue];
  const producer = createVideoQueueProducer(() => clients.shift()!, () => {});
  await assert.rejects(producer.enqueue('first'), { status: 503, code: 'VIDEO_QUEUE_UNAVAILABLE' });
  assert.deepEqual(first.calls, ['stop']);
  assert.equal(await producer.enqueue('second'), 'job-id');
  assert.equal(second.calls.at(-1), 'stop');
});

test('send failure closes the pool and returns a safe service error', async () => {
  const f = fakeQueue();
  f.queue.send = async () => { throw new Error('private connection details'); };
  const producer = createVideoQueueProducer(() => f.queue, () => {});
  await assert.rejects(producer.enqueue('version'), { status: 503, code: 'VIDEO_QUEUE_UNAVAILABLE',
    message: 'The video processing queue is temporarily unavailable.' });
  assert.equal(f.calls.at(-1), 'stop');
});

test('concurrent uploads do not close one another\'s clients', async () => {
  const first = fakeQueue();
  const second = fakeQueue();
  const delayed = deferred<string>();
  first.queue.send = () => delayed.promise;
  const clients = [first.queue, second.queue];
  const producer = createVideoQueueProducer(() => clients.shift()!, () => {});
  const one = producer.enqueue('one');
  assert.equal(await producer.enqueue('two'), 'job-id');
  assert.equal(first.calls.includes('stop'), false);
  assert.equal(second.calls.at(-1), 'stop');
  delayed.resolve('first-job');
  assert.equal(await one, 'first-job');
  assert.equal(first.calls.at(-1), 'stop');
});

test('shutdown waits for in-flight enqueue and refuses new submissions', async () => {
  const f = fakeQueue();
  const sent = deferred<string>();
  f.queue.send = () => sent.promise;
  const producer = createVideoQueueProducer(() => f.queue, () => {});
  const enqueue = producer.enqueue('version');
  let closed = false;
  const close = producer.close().then(() => { closed = true; });
  await assert.rejects(producer.enqueue('too-late'), { code: 'VIDEO_QUEUE_UNAVAILABLE' });
  assert.equal(closed, false);
  sent.resolve('job');
  await enqueue;
  await close;
  assert.equal(closed, true);
  assert.equal(f.calls.at(-1), 'stop');
});

test('duplicate singleton response still closes its client', async () => {
  const f = fakeQueue();
  f.queue.send = async () => null;
  const producer = createVideoQueueProducer(() => f.queue, () => {});
  assert.equal(await producer.enqueue('version'), null);
  assert.equal(f.calls.at(-1), 'stop');
});

test('cleanup failure is reported without misreporting an accepted task as rejected', async () => {
  const f = fakeQueue();
  const errors: string[] = [];
  f.queue.stop = async () => { throw new Error('private details'); };
  const producer = createVideoQueueProducer(() => f.queue, (event) => errors.push(event));
  assert.equal(await producer.enqueue('version'), 'job-id');
  f.emitError();
  assert.deepEqual(errors, ['queue connection cleanup failed', 'background queue operation failed']);
});
