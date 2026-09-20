import { PgBoss } from 'pg-boss';
import { env } from '../config/env.js';
import { VIDEO_TRANSCODE_QUEUE } from './queue.js';

const connectionString = env.VIDEO_QUEUE_MIGRATION_DATABASE_URL;
if (!connectionString) throw new Error('VIDEO_QUEUE_MIGRATION_DATABASE_URL is required for video:queue:prepare.');

const boss = new PgBoss({ connectionString, schema: 'pgboss', migrate: true, createSchema: true, supervise: false });
await boss.start();
await boss.createQueue(VIDEO_TRANSCODE_QUEUE, { retryLimit: 5, retryDelay: 30, expireInSeconds: 4 * 60 * 60 });
// The web role submits jobs but never owns or migrates the pg-boss schema.
for (const statement of [
  'GRANT USAGE ON SCHEMA pgboss TO colearnx_app',
  'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO colearnx_app',
  'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO colearnx_app',
  'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO colearnx_app',
  'GRANT USAGE ON SCHEMA pgboss TO colearnx_video_worker',
  'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO colearnx_video_worker',
  'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO colearnx_video_worker',
  'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO colearnx_video_worker',
]) await boss.getDb().executeSql(statement);
await boss.stop();
