import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import request from 'supertest';

export async function runCourseReuseChecks({ owner, app, environment, passed }) {
  const first = async (sql, params) => (await owner.query(sql, params)).rows[0];
  async function account(role) {
    const id = randomUUID(), sid = randomUUID();
    await owner.query('INSERT INTO users (user_id,full_name,email,password_hash) VALUES ($1,$2,$3,$4)',
      [id, role, id + '@example.test', randomBytes(32).toString('hex')]);
    await owner.query('INSERT INTO profiles (user_id,display_name) VALUES ($1,$2)', [id, 'Reuse ' + role]);
    await owner.query('INSERT INTO roles (role_code,role_name,description) VALUES ($1,$1,$1) ON CONFLICT (role_code) DO NOTHING', [role]);
    await owner.query('INSERT INTO user_roles (user_id,role_id) SELECT $1,role_id FROM roles WHERE role_code=$2', [id, role]);
    await owner.query("INSERT INTO refresh_sessions (session_id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')",
      [sid, id, randomBytes(32).toString('hex')]);
    return { id, token: jwt.sign({ sub: id, sid }, environment.ACCESS_TOKEN_SECRET, { expiresIn: '10m' }) };
  }
  const creator = await account('creator'), trainer = await account('trainer'), other = await account('creator');
  await owner.query("INSERT INTO trainer_certifications (trainer_user_id,certification_name,certification_status) VALUES ($1,'Fixture','approved')", [trainer.id]);
  async function call(user, method, path, body, status = 200) {
    const req = request(app)[method]('/api/v1' + path).set('Authorization', 'Bearer ' + user.token);
    if (body !== undefined) req.send(body);
    return (await req.expect(status)).body;
  }
  async function resource(author, title) {
    const row = await first("INSERT INTO contents (creator_user_id,title,content_type,price_points,publication_status) VALUES ($1,$2,'digital',10,'published') RETURNING content_id AS id", [author.id, title]);
    const version = await first("INSERT INTO content_versions (content_id,version_no,version_status,published_at) VALUES ($1,1,'published',now()) RETURNING content_version_id AS id", [row.id]);
    return { id: row.id, version: version.id };
  }
  async function offering(courseId) {
    return (await first("INSERT INTO course_runs (course_id, run_code, price_points, primary_delivery_type) VALUES ($1,$2,20,'cloud') RETURNING course_run_id AS id", [courseId, randomUUID()])).id;
  }
  async function course(author = trainer) {
    const row = await first("INSERT INTO courses (owner_user_id,title) VALUES ($1,'Draft with a workbook') RETURNING course_id AS id", [author.id]);
    return { id: row.id, run: await offering(row.id) };
  }
  const workbook = await resource(creator, 'Workbook'), unused = await resource(creator, 'Unused resource');
  const foreign = await resource(other, 'Another creator');
  const a = await course(), b = await course(), refundedCourse = await course(other);
  async function purchase() {
    const order = await first("INSERT INTO orders (buyer_user_id,order_no,order_status,total_points,paid_at) VALUES ($1,$2,'partially_refunded',30,now()) RETURNING order_id", [trainer.id, randomUUID()]);
    await owner.query("INSERT INTO order_items (order_id,item_type,course_run_id,seller_user_id,item_title_snapshot,points_amount,fulfilment_status) VALUES ($1,'course_run',$2,$3,'Course',20,'refunded')", [order.order_id, refundedCourse.run, other.id]);
    const line = await first("INSERT INTO order_items (order_id,item_type,content_version_id,seller_user_id,item_title_snapshot,points_amount) VALUES ($1,'content_version',$2,$3,'Workbook',10) RETURNING order_item_id", [order.order_id, workbook.version, creator.id]);
    return (await first(`INSERT INTO content_licenses (content_version_id,order_item_id,buyer_user_id,creator_user_id,license_code,license_terms_json)
      VALUES ($1,$2,$3,$4,$5,'{"courseReuseAllowed":false,"attribution":true}') RETURNING content_license_id AS id`,
      [workbook.version, line.order_item_id, trainer.id, creator.id, randomUUID()])).id;
  }
  const licences = [await purchase(), await purchase()].sort();
  const licencePath = '/content/' + workbook.id + '/reuse-licences';
  const target = licencePath + '/' + licences[1];
  const count = async () => (await call(creator, 'get', '/my/course-reuse')).data.find(row => row.id === workbook.id).courseCount;
  const options = async run => (await call(trainer, 'get', '/courses/' + run + '/resources')).data;
  const validate = async (run, ids) => (await call(trainer, 'post', '/courses/' + run + '/resources/validate', { contentVersionIds: ids })).data;
  const save = async (run, ids, previous, validationId, status = 200) => call(trainer, 'put', '/courses/' + run + '/resources',
    { contentVersionIds: ids, previousContentVersionIds: previous, validationId }, status);
  const permission = (enabled, status = 200) => call(creator, 'put', target, { courseReuseAllowed: enabled }, status);

  const page1 = await call(creator, 'get', '/my/course-reuse?limit=1');
  const page2 = await call(creator, 'get', '/my/course-reuse?limit=1&cursor=' + page1.meta.nextCursor);
  assert.deepEqual([...page1.data, ...page2.data].map(row => row.id).sort(), [workbook.id, unused.id].sort());
  assert.ok([...page1.data, ...page2.data].every(row => row.courseCount === 0));
  assert.equal(page2.meta.hasNext, false);
  assert.deepEqual((await call(other, 'get', '/my/course-reuse')).data.map(row => row.id), [foreign.id]);
  await call(trainer, 'get', '/my/course-reuse', undefined, 403);
  const purchases = (await call(creator, 'get', licencePath)).data;
  assert.deepEqual(purchases.map(row => row.id), licences);
  assert.ok(purchases.every(row => row.buyerLabel === 'Reuse trainer' && !row.courseReuseAllowed && row.version === 1));
  assert.deepEqual((await call(other, 'get', licencePath)).data, []);
  await call(other, 'put', target, { courseReuseAllowed: true }, 404);
  assert.equal((await options(a.run))[0].courseReuseAllowed, false);
  assert.equal((await validate(a.run, [workbook.version])).allowed, false);
  passed('creator portfolios include zero-use resources, paginate and isolate buyers and resources by owner');

  await Promise.all([permission(true), permission(true)]);
  assert.deepEqual((await first('SELECT license_terms_json FROM content_licenses WHERE content_license_id=$1', [licences[1]])).license_terms_json,
    { courseReuseAllowed: true, attribution: true });
  const audit = () => first("SELECT count(*)::int AS n FROM admin_action_logs WHERE target_record_id=$1 AND action_type='content.course_reuse.permission'", [licences[1]]);
  assert.equal((await audit()).n, 1);
  assert.equal((await options(a.run))[0].courseReuseAllowed, true);
  const accepted = await validate(a.run, [workbook.version]);
  assert.equal(accepted.allowed, true);
  assert.equal(await count(), 0);
  await save(a.run, [workbook.version], [], accepted.validationId);
  assert.equal((await options(a.run))[0].selected, true);
  assert.equal(await count(), 1);
  const clearDraft = await validate(a.run, []);
  await save(a.run, [], [], clearDraft.validationId, 409);
  assert.equal(await count(), 1);
  passed('grant and validation alone count zero; saving counts once, concurrent repeat grants audit once and stale drafts cannot overwrite');

  await owner.query("UPDATE content_versions SET version_status='retired' WHERE content_version_id=$1", [workbook.version]);
  const v2 = await first("INSERT INTO content_versions (content_id,version_no,version_status,published_at) VALUES ($1,2,'published',now()) RETURNING content_version_id AS id", [workbook.id]);
  assert.equal((await validate(a.run, [v2.id])).allowed, false);
  const secondRun = await offering(a.id);
  await save(secondRun, [workbook.version], [], (await validate(secondRun, [workbook.version])).validationId);
  const module = await first("INSERT INTO course_modules (course_id,module_title,module_order) VALUES ($1,'Workshop',1) RETURNING module_id", [a.id]);
  await owner.query('INSERT INTO course_module_contents (module_id,content_version_id,display_order) VALUES ($1,$2,1),($1,$3,2)', [module.module_id, workbook.version, v2.id]);
  assert.equal(await count(), 1);
  const next = await validate(b.run, [workbook.version]);
  assert.equal(next.allowed, true);
  await permission(false);
  await save(b.run, [workbook.version], [], next.validationId, 409);
  assert.equal((await options(a.run))[0].selected, true);
  assert.equal(await count(), 1);
  await permission(true);
  await save(b.run, [workbook.version], [], (await validate(b.run, [workbook.version])).validationId);
  assert.equal(await count(), 2);
  await save(b.run, [], [workbook.version], (await validate(b.run, [])).validationId);
  assert.equal(await count(), 1);
  const legacy = await first("INSERT INTO course_modules (course_id,module_title,module_order) VALUES ($1,'Licensed material',1) RETURNING module_id", [b.id]);
  await owner.query('INSERT INTO course_module_contents (module_id,content_license_id,display_order) VALUES ($1,$2,1)', [legacy.module_id, licences[1]]);
  assert.equal(await count(), 2);
  await owner.query('DELETE FROM course_module_contents WHERE module_id=$1', [legacy.module_id]);
  assert.equal(await count(), 1);
  await owner.query("UPDATE courses SET publication_status='archived' WHERE course_id=$1", [a.id]);
  assert.equal(await count(), 1);
  passed('versions, modules and offerings deduplicate by course; a second course adds one, removal subtracts one, saved archives remain visible');

  await owner.query("UPDATE content_licenses SET valid_until=now()-interval '1 day' WHERE content_license_id=$1", [licences[1]]);
  await permission(true, 404);
  assert.equal((await validate(b.run, [workbook.version])).allowed, false);
  await call(creator, 'put', licencePath + '/' + licences[0], { courseReuseAllowed: true });
  await owner.query("UPDATE order_items SET fulfilment_status='refunded' WHERE order_item_id=(SELECT order_item_id FROM content_licenses WHERE content_license_id=$1)", [licences[0]]);
  assert.deepEqual((await call(creator, 'get', licencePath)).data, []);
  await call(creator, 'put', licencePath + '/' + licences[0], { courseReuseAllowed: true }, 404);
  assert.equal((await validate(b.run, [workbook.version])).allowed, false);
  passed('withdrawal, expiry and refunded resource lines block new reuse; a refund of a sibling order line preserves the eligible purchase');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const ownerUrl = new URL(process.env.RELEASE_CHECK_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(ownerUrl.hostname));
  assert.match(ownerUrl.pathname, /^\/colearnx_release_check_[a-z0-9_]+$/);
  const { createApp } = await import('../src/app.ts');
  const { pool } = await import('../src/db/database.ts');
  const owner = new Pool({ connectionString: ownerUrl.href });
  try {
    await runCourseReuseChecks({ owner, app: createApp(), environment: process.env, passed: console.log });
  } finally { await Promise.all([owner.end(), pool.end()]); }
}
