import type { ConstructorOptions, SendOptions } from 'pg-boss';
import { ApiError } from '../lib/http.js';
import { VIDEO_TRANSCODE_EXPIRE_SECONDS, VIDEO_TRANSCODE_QUEUE, VIDEO_TRANSCODE_RETRY_DELAY_SECONDS, VIDEO_TRANSCODE_RETRY_LIMIT } from './constants.js';

type QueueClient = {
  start: () => Promise<unknown>;
  send: (name: string, data: { videoVersionId: string }, options: SendOptions) => Promise<string | null>;
  stop: () => Promise<void>;
  on: (event: 'error', listener: () => void) => unknown;
};

export function videoQueueProducerOptions(connectionString: string): ConstructorOptions {
  return { connectionString, schema: 'pgboss', migrate: false, createSchema: false,
    supervise: false, schedule: false, useListenNotify: false, max: 1, connectionTimeoutMillis: 15_000 };
}

export function createVideoQueueProducer(createQueue: () => QueueClient, reportError: (event: string) => void) {
  const pending = new Set<Promise<string | null>>();
  let closing = false;
  const unavailable = () => new ApiError(503, 'VIDEO_QUEUE_UNAVAILABLE', 'The video processing queue is temporarily unavailable.');

  function enqueue(videoVersionId: string): Promise<string | null> {
    if (closing) return Promise.reject(unavailable());
    const operation = (async () => {
      // A short-lived producer prevents pg-boss's queue-cache refresh timer
      // from querying Neon forever after the first upload. Concurrent uploads
      // own separate clients; one request cannot close another request's pool.
      const queue = createQueue();
      queue.on('error', () => reportError('background queue operation failed'));
      try {
        await queue.start();
        return await queue.send(VIDEO_TRANSCODE_QUEUE, { videoVersionId }, {
          singletonKey: `video-version:${videoVersionId}`,
          retryLimit: VIDEO_TRANSCODE_RETRY_LIMIT,
          retryDelay: VIDEO_TRANSCODE_RETRY_DELAY_SECONDS,
          expireInSeconds: VIDEO_TRANSCODE_EXPIRE_SECONDS,
        });
      } catch {
        throw unavailable();
      } finally {
        // start() can fail after installing timers/opening the pool too.
        try { await queue.stop(); }
        catch { reportError('queue connection cleanup failed'); }
      }
    })();
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  }

  async function close() {
    closing = true;
    await Promise.allSettled([...pending]);
  }

  return { enqueue, close };
}
