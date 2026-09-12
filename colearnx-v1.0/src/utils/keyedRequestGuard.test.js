import assert from 'node:assert/strict';
import test from 'node:test';
import { createKeyedRequestGuard } from './keyedRequestGuard.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

test('downloads of different files run independently and suppress rapid duplicate clicks', async () => {
  const first = deferred(), second = deferred(), snapshots = [];
  const guard = createKeyedRequestGuard((pending) => snapshots.push([...pending]));
  let firstCalls = 0, secondCalls = 0;
  const downloadA = () => guard.run('asset-a', () => { firstCalls++; return first.promise; });
  const downloadB = () => guard.run('asset-b', () => { secondCalls++; return second.promise; });
  const a = downloadA(), b = downloadB();
  await downloadA(); await downloadB();
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);
  assert.deepEqual(snapshots, [['asset-a'], ['asset-a', 'asset-b']]);
  second.resolve('b-url');
  assert.equal(await b, 'b-url');
  assert.deepEqual(snapshots.at(-1), ['asset-a']);
  await downloadA();
  assert.equal(firstCalls, 1);
  first.resolve('a-url');
  assert.equal(await a, 'a-url');
  assert.deepEqual(snapshots.at(-1), []);
});

test('one failed request clears only its own state and permits a retry', async () => {
  const first = deferred(), second = deferred();
  let pending;
  const guard = createKeyedRequestGuard((next) => { pending = next; });
  const a = guard.run('asset-a', () => first.promise);
  const b = guard.run('asset-b', () => second.promise);
  const rejected = assert.rejects(a, /unavailable/);
  first.reject(new Error('unavailable'));
  await rejected;
  assert.deepEqual([...pending], ['asset-b']);
  assert.equal(await guard.run('asset-a', async () => 'retry-url'), 'retry-url');
  assert.deepEqual([...pending], ['asset-b']);
  second.resolve(); await b;
  assert.equal(pending.size, 0);
});

test('synchronous exceptions release a key and snapshots cannot alter the live guard', async () => {
  const guard = createKeyedRequestGuard((pending) => pending.clear());
  const first = deferred();
  const a = guard.run('asset-a', () => first.promise);
  let duplicateCalled = false;
  await guard.run('asset-a', () => { duplicateCalled = true; });
  assert.equal(duplicateCalled, false);
  first.resolve(); await a;
  await assert.rejects(guard.run('asset-a', () => { throw new Error('failed immediately'); }), /failed immediately/);
  assert.equal(await guard.run('asset-a', () => 'retry'), 'retry');
});
