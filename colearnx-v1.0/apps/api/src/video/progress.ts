export type PlaybackEvent = 'playing' | 'pause' | 'seeking' | 'seeked' | 'ended';

export type Heartbeat = {
  sequence: number;
  event: PlaybackEvent;
  positionSeconds: number;
  playbackRate: number;
  clientMonotonicMs: number;
};

export type PreviousHeartbeat = (Heartbeat & { serverReceivedAt: Date }) | null;

export type ConfirmedInterval = { startSeconds: number; endSeconds: number } | null;

// Client clocks are useful only for placing a conservative upper bound on an
// observation; they are never a source of watch credit by themselves.
export function intervalFromHeartbeat(
  previous: PreviousHeartbeat,
  next: Heartbeat,
  durationSeconds: number,
  serverReceivedAt: Date,
  maxGapSeconds: number,
): ConfirmedInterval {
  if (!Number.isSafeInteger(next.sequence) || next.sequence < 1 || next.positionSeconds < 0 || next.positionSeconds > durationSeconds
    || next.playbackRate <= 0 || next.playbackRate > 4 || next.clientMonotonicMs < 0
    || !Number.isFinite(serverReceivedAt.getTime()) || !Number.isFinite(maxGapSeconds) || maxGapSeconds <= 0) {
    throw new Error('HEARTBEAT_INVALID');
  }
  if (!previous || next.sequence <= previous.sequence) return null;
  if (next.clientMonotonicMs < previous.clientMonotonicMs) throw new Error('HEARTBEAT_NON_MONOTONIC');
  // A seek creates a new baseline. It must never turn a position jump into
  // progress, even when a malicious client labels it as a normal heartbeat.
  if (previous.event !== 'playing' || next.event === 'seeking') return null;
  const distance = next.positionSeconds - previous.positionSeconds;
  if (distance <= 0) return null;
  const clientElapsedSeconds = (next.clientMonotonicMs - previous.clientMonotonicMs) / 1000;
  const serverElapsedSeconds = (serverReceivedAt.getTime() - previous.serverReceivedAt.getTime()) / 1000;
  // Credit is bounded by the lesser of client and server elapsed time. A clock
  // jump cannot turn rapid requests into viewing credit; a large gap resets
  // the baseline without filling the intervening interval.
  if (clientElapsedSeconds <= 0 || serverElapsedSeconds <= 0 || serverElapsedSeconds > maxGapSeconds) return null;
  const allowedDistance = Math.min(clientElapsedSeconds, serverElapsedSeconds)
    * Math.max(previous.playbackRate, next.playbackRate) * 1.25;
  if (distance > allowedDistance) throw new Error('HEARTBEAT_OUT_OF_BOUNDS');
  return { startSeconds: previous.positionSeconds, endSeconds: next.positionSeconds };
}

export function mergeIntervals(intervals: Array<{ startSeconds: number; endSeconds: number }>, durationSeconds: number) {
  const sorted = intervals
    .map((interval) => ({ startSeconds: Math.max(0, interval.startSeconds), endSeconds: Math.min(durationSeconds, interval.endSeconds) }))
    .filter((interval) => interval.endSeconds > interval.startSeconds)
    .sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds);
  const merged: Array<{ startSeconds: number; endSeconds: number }> = [];
  for (const interval of sorted) {
    const current = merged.at(-1);
    if (current && interval.startSeconds <= current.endSeconds) current.endSeconds = Math.max(current.endSeconds, interval.endSeconds);
    else merged.push(interval);
  }
  return merged;
}

export function uniqueWatchedSeconds(intervals: Array<{ startSeconds: number; endSeconds: number }>, durationSeconds: number) {
  return mergeIntervals(intervals, durationSeconds).reduce((total, interval) => total + interval.endSeconds - interval.startSeconds, 0);
}
