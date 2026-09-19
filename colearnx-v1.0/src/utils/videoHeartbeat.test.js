import test from "node:test";
import assert from "node:assert/strict";
import { createHeartbeatReporter } from "./videoHeartbeat.js";

test("seeking boundaries retain event-time positions and increasing sequences while requests serialize", async () => {
  const requests = []; let release;
  const reporter = createHeartbeatReporter({ sessionId: "s", now: () => 20, send: body => { requests.push(body); return requests.length === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve({}); } });
  const media = { currentTime: 10, playbackRate: 1 };
  reporter.report("playing", media); await Promise.resolve();
  media.currentTime = 200; reporter.report("seeking", media); const done = reporter.report("seeked", media);
  media.currentTime = 300; assert.equal(requests.length, 1); release({}); await done;
  assert.deepEqual(requests.map(r => [r.sequence, r.event, r.positionSeconds]), [[1, "playing", 10], [2, "seeking", 200], [3, "seeked", 200]]);
  assert.deepEqual(Object.keys(requests[0]).sort(), ["sessionId", "sequence", "event", "positionSeconds", "playbackRate", "clientMonotonicMs"].sort());
});
test("network failures never add local progress or replay old observations", async () => {
  let progress = 0, error = 0, calls = 0;
  const reporter = createHeartbeatReporter({ sessionId: "s", send: async () => { calls++; throw Error(); }, onProgress: () => progress++, onError: () => error++ });
  await reporter.report("playing", { currentTime: 5, playbackRate: 1 });
  assert.equal(progress, 0); assert.equal(error, 1); assert.equal(calls, 1);
  reporter.close(); await reporter.report("playing", { currentTime: 8, playbackRate: 1 }); assert.equal(calls, 1);
});
