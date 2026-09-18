import { HEARTBEAT_EVENTS } from "./videoContract.js";

// Capture at event time; serialize delivery so seeking/pause boundaries are not lost.
// Failed observations are discarded, never replayed later as fresh watch evidence.
export function createHeartbeatReporter({ sessionId, send, onProgress = () => {}, onError = () => {}, now = () => performance.now() }) {
  let sequence = 0, tail = Promise.resolve(), closed = false;
  return {
    report(event, media) {
      if (closed || !HEARTBEAT_EVENTS.includes(event) || !Number.isFinite(media.currentTime) || !Number.isFinite(media.playbackRate)) return tail;
      const body = { sessionId, sequence: ++sequence, event, positionSeconds: Math.max(0, media.currentTime), playbackRate: media.playbackRate, clientMonotonicMs: now() };
      const observedAt = now();
      tail = tail.then(async () => {
        if (now() - observedAt > 10000) return;
        try { const result = await send(body); if (!closed) onProgress(result); }
        catch (error) { if (!closed) onError(error); }
      });
      return tail;
    },
    close() { closed = true; },
  };
}
