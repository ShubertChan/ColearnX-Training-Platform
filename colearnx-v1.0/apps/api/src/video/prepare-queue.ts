import { PgBoss } from 'pg-boss';
import { loadQueueMigrationEnv } from '../config/migration-env.js';
import { VIDEO_TRANSCODE_QUEUE } from './constants.js';

const { VIDEO_QUEUE_MIGRATION_DATABASE_URL: connectionString } = loadQueueMigrationEnv();

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
