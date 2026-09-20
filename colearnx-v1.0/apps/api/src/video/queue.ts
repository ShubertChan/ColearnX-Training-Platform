import { PgBoss } from 'pg-boss';
import { env } from '../config/env.js';
import { ApiError } from '../lib/http.js';
import { VIDEO_TRANSCODE_QUEUE } from './constants.js';

export type VideoTranscodeJob = { videoVersionId: string };

let queue: PgBoss | undefined;
let queueStarted = false;

function queueConnectionString() {
  return env.VIDEO_QUEUE_DATABASE_URL || env.DATABASE_URL;
}

async function boss() {
  // API processes only submit jobs. The deployment-owned `video:queue:prepare`
  // command creates/migrates pg-boss, so a compromised web role cannot change
  // the queue schema during a request.
  queue ??= new PgBoss({
    connectionString: queueConnectionString(),
    schema: 'pgboss',
    migrate: false,
    createSchema: false,
    supervise: false,
  });
  if (!queueStarted) {
    try {
      await queue.start();
      queueStarted = true;
    } catch {
      queue = undefined;
      throw new ApiError(503, 'VIDEO_QUEUE_UNAVAILABLE', 'The video processing queue is temporarily unavailable.');
    }
  }
  return queue;
}

export async function enqueueVideoTranscode(videoVersionId: string) {
  const jobId = await (await boss()).send(VIDEO_TRANSCODE_QUEUE, { videoVersionId }, {
    singletonKey: `video-version:${videoVersionId}`,
    retryLimit: 5,
    retryDelay: 30,
    expireInSeconds: 4 * 60 * 60,
  });
  return jobId;
}

export async function closeVideoQueue() {
  if (queueStarted && queue) await queue.stop();
  queue = undefined;
  queueStarted = false;
}
