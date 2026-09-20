import assert from 'node:assert/strict';
import test from 'node:test';
import { intervalFromHeartbeat, uniqueWatchedSeconds } from './progress.js';

test('only contiguous, plausibly timed playback becomes a watch interval', () => {
  const receivedAt = new Date('2026-09-19T00:00:01.000Z');
  const prior = { sequence: 1, event: 'playing' as const, positionSeconds: 10, playbackRate: 1, clientMonotonicMs: 1_000, serverReceivedAt: receivedAt };
  assert.deepEqual(intervalFromHeartbeat(prior, { sequence: 2, event: 'pause', positionSeconds: 17, playbackRate: 1, clientMonotonicMs: 8_000 }, 100, new Date('2026-09-19T00:00:08.000Z'), 30), { startSeconds: 10, endSeconds: 17 });
  assert.equal(intervalFromHeartbeat({ ...prior, event: 'seeking' }, { sequence: 2, event: 'seeked', positionSeconds: 90, playbackRate: 1, clientMonotonicMs: 2_000 }, 100, new Date('2026-09-19T00:00:02.000Z'), 30), null);
  assert.throws(() => intervalFromHeartbeat(prior, { sequence: 2, event: 'playing', positionSeconds: 80, playbackRate: 1, clientMonotonicMs: 2_000 }, 100, new Date('2026-09-19T00:00:02.000Z'), 30), /HEARTBEAT_OUT_OF_BOUNDS/);
});

test('a forged client clock or heartbeat gap cannot earn extra viewing credit', () => {
  const prior = { sequence: 1, event: 'playing' as const, positionSeconds: 0, playbackRate: 1, clientMonotonicMs: 1_000, serverReceivedAt: new Date('2026-09-19T00:00:00.000Z') };
  assert.throws(() => intervalFromHeartbeat(prior, { sequence: 2, event: 'playing', positionSeconds: 14_000, playbackRate: 1, clientMonotonicMs: 14_001_000 }, 14_400, new Date('2026-09-19T00:00:01.000Z'), 30), /HEARTBEAT_OUT_OF_BOUNDS/);
  assert.equal(intervalFromHeartbeat(prior, { sequence: 2, event: 'playing', positionSeconds: 10, playbackRate: 1, clientMonotonicMs: 10_000 }, 100, new Date('2026-09-19T00:01:00.000Z'), 30), null);
});

test('overlapping intervals across browser sessions only count once', () => {
  assert.equal(uniqueWatchedSeconds([
    { startSeconds: 0, endSeconds: 12 },
    { startSeconds: 10, endSeconds: 20 },
    { startSeconds: 50, endSeconds: 55 },
  ], 60), 25);
});
