import { PgBoss } from 'pg-boss';
import { env } from '../config/env.js';
import { createVideoQueueProducer, videoQueueProducerOptions } from './queue-producer.js';

export type VideoTranscodeJob = { videoVersionId: string };

const producer = createVideoQueueProducer(
  () => new PgBoss(videoQueueProducerOptions(env.VIDEO_QUEUE_DATABASE_URL || env.DATABASE_URL)),
  (event) => process.stderr.write(`Video queue: ${event}.\n`),
);

export const enqueueVideoTranscode = producer.enqueue;
export const closeVideoQueue = producer.close;
