/** Run only against a NEW empty LOCAL test database, never staging/production.
 * VIDEO_START_CHECK_DATABASE_URL=postgresql://owner@127.0.0.1:port/colearnx_release_check_video_<unique>
 * node --import tsx scripts/video-start-integration-check.mjs
 * Uses the real non-owner colearnx_app login and real HTTP handlers. No cloud I/O.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import jwt from 'jsonwebtoken';
import request from 'supertest';

const ownerUrl = new URL(process.env.VIDEO_START_CHECK_DATABASE_URL || 'invalid');
assert.ok(['postgres:', 'postgresql:'].includes(ownerUrl.protocol));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(ownerUrl.hostname), 'Remote databases prohibited.');
assert.match(decodeURIComponent(ownerUrl.pathname.slice(1)), /^colearnx_release_check_video_[a-z0-9_]+$/);
assert.equal(ownerUrl.search, ''); assert.equal(ownerUrl.hash, '');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const password = randomBytes(32).toString('hex');
const runtimeUrl = new URL(ownerUrl); runtimeUrl.username = 'colearnx_app'; runtimeUrl.password = password;
const operatingEnvironment = {};
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[key]) operatingEnvironment[key] = process.env[key];
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, operatingEnvironment, {
  NODE_ENV: 'development', DATABASE_URL: runtimeUrl.href, DATABASE_SSL: 'false', DB_POOL_MAX: '4',
  DOTENV_CONFIG_PATH: process.platform === 'win32' ? 'NUL' : '/dev/null', DOTENV_CONFIG_QUIET: 'true',
  APP_ORIGIN: 'http://localhost:5173', API_ORIGIN: 'http://localhost:3001', LOG_LEVEL: 'silent',
  ACCESS_TOKEN_SECRET: randomBytes(32).toString('hex'), REFRESH_TOKEN_SECRET: randomBytes(32).toString('hex'), CSRF_SECRET: randomBytes(32).toString('hex'),
  ENABLE_HOSTED_VIDEO: 'true', VIDEO_PLAYBACK_TOKEN_SECRET: randomBytes(32).toString('hex'), VIDEO_PLAYBACK_GATEWAY_ORIGIN: 'http://localhost:8787',
  OBJECT_STORAGE_PROVIDER: 'disabled', EMAIL_PROVIDER: 'disabled', PWNED_PASSWORDS_ENABLED: 'false', REDIS_URL: '',
});
const owner = new Pool({ connectionString: ownerUrl.href, ssl: false, max: 1 });
let runtime, checks = 0, externalCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { externalCalls++; throw new Error('External HTTP prohibited.'); };
const pass = label => { checks++; process.stdout.write(`PASS ${label}\n`); };
try {
  const count = await owner.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'");
  assert.equal(count.rows[0].count, 0, 'Target must be empty; this script never erases existing data.');
  const databases = await owner.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'");
  assert.ok(databases.rows.every(row => /^colearnx_release_check_[a-z0-9_]+$/.test(row.datname)), 'Use a disposable cluster containing only test databases.');
  process.stdout.write(`PostgreSQL ${(await owner.query('SHOW server_version')).rows[0].server_version}\n`);
  for (const role of ['colearnx_app', 'colearnx_migrator', 'colearnx_readonly']) {
    if (!(await owner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount) await owner.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  }
  await owner.query(`ALTER ROLE colearnx_app LOGIN PASSWORD '${password}'`);
  const migrationDir = join(root, '../../db/migrations');
  await owner.query('CREATE TABLE schema_migrations (filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const file of (await readdir(migrationDir)).filter(file => file.endsWith('.sql')).sort()) await owner.query(await readFile(join(migrationDir, file), 'utf8'));
  const database = await import('../src/db/database.ts'); runtime = database.pool;
  assert.equal((await runtime.query('SELECT session_user')).rows[0].session_user, 'colearnx_app');
  assert.equal((await owner.query("SELECT rolsuper FROM pg_roles WHERE rolname = 'colearnx_app'")).rows[0].rolsuper, false);
  pass('fresh schema and real restricted runtime login');
  const { createApp } = await import('../src/app.ts'); const app = createApp();
  const trainer = randomUUID(), buyer = randomUUID(), outsider = randomUUID();
  await owner.query("INSERT INTO roles (role_code, role_name, description) VALUES ('member','Member','Fixture'),('trainer','Trainer','Fixture')");
  const tokens = new Map();
  for (const [id, role, label] of [[trainer, 'trainer', 'Trainer'], [buyer, 'member', 'Buyer'], [outsider, 'member', 'Other']]) {
    await owner.query("INSERT INTO users (user_id,full_name,email,password_hash) VALUES ($1,$2,$3,'fixture-not-a-login-hash')", [id, `Fixture ${label}`, `${label.toLowerCase()}@example.test`]);
    await owner.query('INSERT INTO user_roles (user_id,role_id) SELECT $1,role_id FROM roles WHERE role_code = $2', [id, role]);
    const session = randomUUID();
    await owner.query("INSERT INTO refresh_sessions (session_id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')", [session,id,createHash('sha256').update(randomBytes(32)).digest('hex')]);
    tokens.set(id, jwt.sign({ sub: id, sid: session }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '10m' }));
  }
  await owner.query("INSERT INTO trainer_certifications (trainer_user_id,certification_name,certification_status) VALUES ($1,'Fixture','approved')", [trainer]);
  const post = (actor, path, body = {}) => request(app).post(`/api/v1${path}`).set('Authorization', `Bearer ${tokens.get(actor)}`).send(body);
  const get = (actor, path) => request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${tokens.get(actor)}`);
  const input = { title: 'Scheduled protected video', description: 'A fixture course', pricePoints: 20, deliveryModes: ['cloud'], progressTrackingType: 'online_video' };
  assert.equal((await post(trainer, '/courses', input)).status, 400);
  pass('API rejects video creation without a start time');
  const created = await post(trainer, '/courses', { ...input, startsAt: '2099-01-01T00:00:00.000Z' });
  assert.equal(created.status, 201, JSON.stringify(created.body)); const run = created.body.data.id;
  pass('Trainer can create a scheduled video draft');
  const course = (await owner.query('SELECT course_id FROM course_runs WHERE course_run_id=$1', [run])).rows[0].course_id;
  const asset = randomUUID(), version = randomUUID(), order = randomUUID(), item = randomUUID();
  await owner.query(`INSERT INTO course_delivery_assets (course_delivery_asset_id,course_run_id,owner_user_id,asset_purpose,bucket_name,object_key,original_filename,declared_content_type,declared_byte_size,verified_content_type,verified_byte_size,etag,asset_status,upload_expires_at,verified_at)
    VALUES ($1,$2,$3,'video_source','fixture-bucket','fixture/source.mp4','source.mp4','video/mp4',10,'video/mp4',10,'fixture','ready',now()+interval '1 day',now())`, [asset,run,trainer]);
  await owner.query(`INSERT INTO course_video_versions (course_video_version_id,course_run_id,source_asset_id,version_no,video_status,is_current,duration_seconds,width,height,hls_bucket_name,hls_output_prefix,hls_master_key,thumbnail_key,ready_at)
    VALUES ($1,$2,$3,1,'ready',true,100,1920,1080,'fixture-hls',$4,$5,'fixture/thumb.jpg',now())`, [version,run,asset,`course-video-hls/${version}/`,`course-video-hls/${version}/master.m3u8`]);
  await owner.query('UPDATE course_runs SET total_duration_seconds=100 WHERE course_run_id=$1',[run]);
  const update = await request(app).patch(`/api/v1/courses/${run}`).set('Authorization', `Bearer ${tokens.get(trainer)}`).send({ ...input, startsAt:'2099-02-01T00:00:00.000Z' });
  assert.equal(update.status,200,JSON.stringify(update.body));
  const preserved = (await owner.query('SELECT progress_tracking_type,total_duration_seconds,starts_at FROM course_runs WHERE course_run_id=$1',[run])).rows[0];
  assert.equal(preserved.progress_tracking_type,'online_video'); assert.equal(preserved.total_duration_seconds,100);
  assert.equal(preserved.starts_at.toISOString(),'2099-02-01T00:00:00.000Z');
  pass('draft schedule update preserves server-verified video duration and type');
  assert.equal((await get(trainer, `/courses/${run}/video`)).body.data.canSubmit,true);
  await owner.query("INSERT INTO orders (order_id,buyer_user_id,order_no,total_points) VALUES ($1,$2,$3,20)", [order,buyer,`fixture-${order}`]);
  await owner.query(`INSERT INTO order_items (order_item_id,order_id,item_type,course_run_id,seller_user_id,item_title_snapshot,points_amount,fulfilment_status,course_video_version_id)
    VALUES ($1,$2,'course_run',$3,$4,'Scheduled protected video',20,'fulfilled',$5)`, [item,order,run,trainer,version]);
  await owner.query('INSERT INTO course_enrolments (course_run_id,learner_user_id,order_item_id) VALUES ($1,$2,$3)', [run,buyer,item]);
  await owner.query("UPDATE course_delivery_options SET option_status='active' WHERE course_run_id=$1",[run]);
  const deliveryPath = `/order-items/${item}/delivery`, playbackPath = `/order-items/${item}/playback-sessions`;
  const future = await get(buyer, deliveryPath); assert.equal(future.status,200,JSON.stringify(future.body));
  assert.match(future.headers['cache-control'],/private, no-store/);
  assert.equal(future.body.data.playerState,'scheduled'); assert.equal(future.body.data.title,input.title); assert.ok(future.body.data.serverTime);
  assert.equal((await post(buyer, playbackPath)).body.error.code,'COURSE_NOT_STARTED');
  assert.equal((await owner.query('SELECT count(*)::int AS count FROM course_video_progress_sessions')).rows[0].count,0);
  pass('purchaser sees schedule but cannot obtain any playback session before start');
  assert.equal((await get(outsider, deliveryPath)).status,404);
  assert.equal((await post(outsider, playbackPath)).body.error.code,'PLAYBACK_UNAUTHORISED');
  pass('direct delivery and playback URLs remain purchase-authorised');
  await owner.query('UPDATE course_runs SET starts_at=NULL WHERE course_run_id=$1',[run]);
  assert.equal((await get(buyer, deliveryPath)).body.data.playerState,'schedule_required');
  assert.equal((await post(buyer, playbackPath)).body.error.code,'COURSE_START_REQUIRED');
  assert.equal((await post(trainer, `/courses/${run}/submit`)).body.error.code,'COURSE_START_REQUIRED');
  assert.equal((await get(trainer, `/courses/${run}/video`)).body.data.canSubmit,false);
  pass('legacy missing schedule fails closed at delivery, playback and submission');
  await owner.query('UPDATE course_runs SET starts_at=clock_timestamp() WHERE course_run_id=$1',[run]);
  assert.equal((await get(buyer, deliveryPath)).body.data.playerState,'ready');
  const session = await post(buyer, playbackPath); assert.equal(session.status,201,JSON.stringify(session.body));
  assert.equal(session.body.data.videoVersionId,version); assert.match(session.body.data.authorization.token,/^v1\./);
  pass('opening at server time authorises the immutable purchased video');
  const heartbeat = { sessionId:session.body.data.sessionId,sequence:1,event:'playing',positionSeconds:0,playbackRate:1,clientMonotonicMs:0 };
  assert.equal((await post(buyer, `/order-items/${item}/progress`, heartbeat)).status,200);
  await owner.query("UPDATE course_runs SET starts_at=now()+interval '1 day' WHERE course_run_id=$1",[run]);
  assert.equal((await post(buyer, `/order-items/${item}/progress`, {...heartbeat,sequence:2})).body.error.code,'COURSE_NOT_STARTED');
  pass('heartbeats also enforce the schedule instead of accepting forged progress');
  await owner.query("UPDATE course_runs SET starts_at=now()-interval '1 day' WHERE course_run_id=$1",[run]);
  assert.equal((await post(trainer, `/courses/${run}/submit`)).status,200);
  pass('a fully prepared scheduled draft can still be submitted');
  const submittedUpdate = await request(app).patch(`/api/v1/courses/${run}`).set('Authorization', `Bearer ${tokens.get(trainer)}`).send({ ...input, startsAt:'2099-02-01T00:00:00.000Z' });
  assert.equal(submittedUpdate.body.error.code,'COURSE_NOT_DRAFT');
  pass('submitted course cannot bypass review through a schedule update');
  await owner.query("UPDATE course_enrolments SET enrolment_status='refunded' WHERE order_item_id=$1",[item]);
  assert.equal((await post(buyer, playbackPath)).body.error.code,'PLAYBACK_UNAUTHORISED');
  pass('refunded enrolment cannot renew playback');
  assert.equal(externalCalls,0); pass('no external HTTP or cloud object access');
  process.stdout.write(`${checks} database/API checks passed. Fixture data retained.\n`);
} finally { globalThis.fetch=originalFetch; if(runtime) await runtime.end(); await owner.end(); }
