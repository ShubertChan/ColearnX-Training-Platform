// Called only by the guarded, local PostgreSQL release integration runner.
// Synthetic users only; no external mail, payment, or object-storage requests.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { beginEnrolment, confirmEnrolment, readMfaState } from '../src/auth/mfa/service.ts';
import { totpCodeForStep, totpStep } from '../src/auth/mfa/totp.ts';
import { issueChallenge } from '../src/auth/mfa/challenge.ts';
import { env } from '../src/config/env.ts';

export async function runMfaSessionChecks({ owner, app, apiPool, environment, passed }) {
  const password = randomBytes(24).toString('hex');
  const passwordHash = await argon2.hash(password);
  let address = 30;
  const createUser = async (label, admin = false) => {
    const user = { id: randomUUID(), email: `mfa-${label}@example.test`, ip: `192.0.2.${address++}` };
    await owner.query('INSERT INTO users(user_id,full_name,email,password_hash) VALUES($1,$2,$3,$4)',
      [user.id, label, user.email, passwordHash]);
    await owner.query(`INSERT INTO user_roles(user_id,role_id) SELECT $1,role_id FROM roles
      WHERE role_code='member' OR ($2 AND role_code='admin')`, [user.id, admin]);
    return user;
  };
  const post = (user, path, data) => request(app).post(`/api/v1${path}`).set('X-Forwarded-For', user.ip).send(data);
  const login = user => post(user, '/auth/login', { email: user.email, password });
  const token = response => response.body.data.accessToken;
  const cookie = response => response.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
  const me = response => request(app).get('/api/v1/me').auth(token(response), { type: 'bearer' });
  const refresh = (user, response) => post(user, '/auth/refresh', {}).set('Cookie', cookie(response))
    .set('Origin', environment.APP_ORIGIN).set('X-CSRF-Token', response.body.data.csrfToken);
  const enrol = async user => {
    const pending = await beginEnrolment(user.id, user.email);
    assert.equal(pending.alreadyEnrolled, false);
    const confirmed = await confirmEnrolment(user.id, totpCodeForStep(pending.secret, totpStep(Date.now())));
    assert.equal(confirmed.status, 'confirmed');
    return confirmed.recoveryCodes;
  };

  // Repeatedly restarting password authentication must not reset MFA failures.
  const lockedUser = await createUser('lockout');
  const recoveryCodes = await enrol(lockedUser);
  let challenge;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const first = await login(lockedUser).expect(200);
    assert.equal(first.body.data.mfaRequired, true);
    assert.equal(token(first), undefined);
    assert.equal(first.headers['set-cookie'], undefined);
    challenge = first.body.data.mfaToken;
    await post(lockedUser, '/auth/mfa/verify', { mfaToken: challenge, code: 'not-a-real-recovery-code' }).expect(401);
    const counter = (await owner.query('SELECT consecutive_failures FROM auth_failure_counters WHERE user_id=$1', [lockedUser.id])).rows[0];
    assert.equal(counter.consecutive_failures, attempt);
  }
  await login(lockedUser).expect(401);
  await post(lockedUser, '/auth/mfa/verify', { mfaToken: challenge, code: recoveryCodes[0] }).expect(401);
  assert.equal((await readMfaState(lockedUser.id)).recoveryCodesRemaining, recoveryCodes.length);
  await owner.query("UPDATE auth_failure_counters SET locked_until=now()-interval '1 second' WHERE user_id=$1", [lockedUser.id]);
  const unlocked = await post(lockedUser, '/auth/mfa/verify', { mfaToken: challenge, code: recoveryCodes[0] }).expect(200);
  assert.ok(token(unlocked));
  assert.equal((await owner.query('SELECT consecutive_failures FROM auth_failure_counters WHERE user_id=$1', [lockedUser.id])).rows[0].consecutive_failures, 0);
  await post(lockedUser, '/auth/mfa/verify', { mfaToken: challenge, code: recoveryCodes[0] }).expect(401);
  passed('MFA failures accumulate 1–5 across password restarts, lock blocks login without consuming recovery codes, full authentication clears failures, recovery codes remain single-use');

  // Force a concurrent confirmation to commit while a restart waits on its row.
  const raceUser = await createUser('enrol-race');
  await beginEnrolment(raceUser.id, raceUser.email);
  const encryptedBefore = (await owner.query('SELECT secret_encrypted FROM user_mfa_secrets WHERE user_id=$1', [raceUser.id])).rows[0].secret_encrypted;
  const lock = await owner.connect();
  const originalQuery = apiPool.query;
  let observed, restarted;
  const dispatched = new Promise(resolve => { observed = resolve; });
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT user_id FROM user_mfa_secrets WHERE user_id=$1 FOR UPDATE', [raceUser.id]);
    apiPool.query = function (...args) {
      const result = originalQuery.apply(this, args);
      if (typeof args[0] === 'string' && args[0].includes('INSERT INTO user_mfa_secrets') && args[1]?.[0] === raceUser.id) observed();
      return result;
    };
    restarted = beginEnrolment(raceUser.id, raceUser.email);
    await dispatched;
    await lock.query('UPDATE user_mfa_secrets SET confirmed_at=now() WHERE user_id=$1', [raceUser.id]);
    await lock.query('COMMIT');
    assert.equal((await restarted).alreadyEnrolled, true);
  } finally {
    apiPool.query = originalQuery;
    await lock.query('ROLLBACK'); lock.release();
    await restarted?.catch(() => {});
  }
  assert.equal((await readMfaState(raceUser.id)).enrolled, true);
  assert.equal((await owner.query('SELECT secret_encrypted FROM user_mfa_secrets WHERE user_id=$1', [raceUser.id])).rows[0].secret_encrypted, encryptedBefore);
  passed('concurrent enrolment restart cannot replace a just-confirmed factor or its encrypted secret');

  const member = await createUser('sessions');
  const one = await login(member).expect(200);
  const two = await login(member).expect(200);
  const legacy = jwt.sign({ sub: member.id }, environment.ACCESS_TOKEN_SECRET, { expiresIn: '15m' });
  await request(app).get('/api/v1/me').auth(legacy, { type: 'bearer' }).expect(401);
  const oneRotated = await refresh(member, one).expect(200);
  const twoRotated = await refresh(member, two).expect(200);
  await me(one).expect(200); await me(oneRotated).expect(200);
  const list = await request(app).get('/api/v1/auth/sessions').auth(token(one), { type: 'bearer' }).expect(200);
  assert.equal(list.body.data.sessions.filter(item => item.current).length, 1);
  assert.equal(list.body.data.sessions.find(item => item.current).id, jwt.decode(token(oneRotated)).sid);
  const others = await post(member, '/auth/sessions/revoke-others', {}).auth(token(one), { type: 'bearer' }).expect(200);
  assert.equal(others.body.data.revoked, 1);
  await me(two).expect(401); await me(twoRotated).expect(401);
  await refresh(member, twoRotated).expect(401); await refresh(member, two).expect(401);
  await me(oneRotated).expect(200);
  const stranger = await createUser('other-owner');
  const strangerSession = await login(stranger).expect(200);
  await request(app).delete(`/api/v1/auth/sessions/${jwt.decode(token(strangerSession)).sid}`)
    .auth(token(oneRotated), { type: 'bearer' }).expect(404);
  await me(strangerSession).expect(200);
  // Logout accepts an ancestor cookie when refresh won a concurrent rotation.
  await post(member, '/auth/logout', {}).set('Cookie', cookie(one)).set('Origin', environment.APP_ORIGIN)
    .set('X-CSRF-Token', one.body.data.csrfToken).expect(200);
  await me(one).expect(401); await me(oneRotated).expect(401);
  passed('legacy JWT refresh upgrade, normal rotation continuity, one current device, immediate revocation of old/new JWTs, retained-device replay protection, ownership checks and logout');

  // Regardless of which request wins, revocation must leave no active successor.
  const racer = await createUser('refresh-revoke');
  const kept = await login(racer).expect(200);
  const ended = await login(racer).expect(200);
  const raced = await Promise.all([
    refresh(racer, ended),
    request(app).delete(`/api/v1/auth/sessions/${jwt.decode(token(ended)).sid}`).auth(token(kept), { type: 'bearer' }),
  ]);
  assert.ok([200, 401].includes(raced[0].status)); assert.equal(raced[1].status, 200);
  await me(ended).expect(401);
  if (raced[0].status === 200) await me(raced[0]).expect(401);
  assert.equal((await owner.query('SELECT count(*)::int AS count FROM refresh_sessions WHERE user_id=$1 AND revoked_at IS NULL', [racer.id])).rows[0].count, 1);
  await me(kept).expect(200);
  passed('concurrent refresh and device revocation cannot leave an active successor');

  const admin = await createUser('administrator', true);
  const adminOne = await login(admin).expect(200);
  const adminTwo = await login(admin).expect(200);
  const gate = await request(app).get('/api/v1/admin/role-applications').auth(token(adminOne), { type: 'bearer' }).expect(403);
  assert.equal(gate.body.error.code, 'MFA_ENROLMENT_REQUIRED');
  const adminCodes = await enrol(admin);
  const applicant = await createUser('applicant');
  const applicantSession = await login(applicant).expect(200);
  await owner.query("INSERT INTO roles(role_code,role_name,description) VALUES('creator','Creator','Fixture') ON CONFLICT(role_code) DO NOTHING");
  const application = await post(applicant, '/role-applications', { requestedRole: 'creator', supportingText: 'Synthetic local integration application only.' })
    .auth(token(applicantSession), { type: 'bearer' }).expect(201);
  const decisionPath = `/admin/role-applications/${application.body.data.id}/decision`;
  const decision = { decision: 'approved', reason: 'Synthetic integration approval' };
  const missing = await post(admin, decisionPath, decision).auth(token(adminOne), { type: 'bearer' }).expect(401);
  assert.equal(missing.body.error.code, 'STEP_UP_REQUIRED');
  const proofResponse = await post(admin, '/auth/step-up', { code: adminCodes[0] }).auth(token(adminOne), { type: 'bearer' }).expect(200);
  const proof = proofResponse.body.data.stepUpToken;
  await post(admin, decisionPath, decision).auth(token(adminTwo), { type: 'bearer' }).set('X-Step-Up-Token', proof).expect(401);
  const expired = issueChallenge('step-up', admin.id, 1, env.MFA_CHALLENGE_SECRET, Date.now() - 2000, jwt.decode(token(adminOne)).sid);
  await post(admin, decisionPath, decision).auth(token(adminOne), { type: 'bearer' }).set('X-Step-Up-Token', expired).expect(401);
  assert.equal((await owner.query('SELECT application_status FROM role_applications WHERE application_id=$1', [application.body.data.id])).rows[0].application_status, 'pending');
  const adminRotated = await refresh(admin, adminOne).expect(200);
  await post(admin, decisionPath, decision).auth(token(adminRotated), { type: 'bearer' }).set('X-Step-Up-Token', proof).expect(200);
  assert.ok((await me(applicantSession).expect(200)).body.data.roles.includes('creator'));
  passed('administrator enrolment gate, real role approval with step-up, rejection of expired/other-browser proofs without mutation, proof survives ordinary rotation');

  // Presigning is local cryptography only: synthetic credentials, no S3 calls.
  const content = randomUUID(), version = randomUUID();
  await owner.query(`INSERT INTO contents(content_id,creator_user_id,title,content_type,price_points,publication_status)
    VALUES($1,$2,'Local attachment fixture','digital',0,'draft')`, [content, applicant.id]);
  await owner.query("INSERT INTO content_versions(content_version_id,content_id,version_no,version_status) VALUES($1,$2,1,'draft')", [version, content]);
  const assets = [randomUUID(), randomUUID()];
  for (let index = 0; index < assets.length; index++) {
    await owner.query(`INSERT INTO storage_assets(storage_asset_id,content_version_id,owner_user_id,bucket_name,object_key,
      original_filename,declared_content_type,declared_byte_size,verified_content_type,verified_byte_size,asset_status,upload_expires_at,verified_at)
      VALUES($1,$2,$3,'local-test-only',$4,$5,'application/pdf',100,'application/pdf',100,'ready',now()+interval '1 hour',now())`,
    [assets[index], version, applicant.id, `fixture/preview-${index}.pdf`, `preview-${index}.pdf`]);
  }
  const previewPath = `/admin/content-versions/${version}/preview-url`;
  await post(admin, previewPath, { assetId: assets[0] }).auth(token(adminRotated), { type: 'bearer' }).expect(401);
  const oldStorage = Object.fromEntries(['OBJECT_STORAGE_PROVIDER','R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET_NAME'].map(key => [key, env[key]]));
  Object.assign(env, { OBJECT_STORAGE_PROVIDER: 'r2', R2_ACCOUNT_ID: 'local-fixture', R2_ACCESS_KEY_ID: 'synthetic-local-only', R2_SECRET_ACCESS_KEY: randomBytes(32).toString('hex'), R2_BUCKET_NAME: 'local-test-only' });
  try {
    for (let index = 0; index < assets.length; index++) {
      const preview = await post(admin, previewPath, { assetId: assets[index] }).auth(token(adminRotated), { type: 'bearer' }).set('X-Step-Up-Token', proof).expect(200);
      assert.equal(preview.body.data.assetId, assets[index]);
      assert.equal(preview.body.data.filename, `preview-${index}.pdf`);
      assert.ok(new URL(preview.body.data.previewUrl).pathname.endsWith(`/preview-${index}.pdf`));
    }
  } finally { Object.assign(env, oldStorage); }
  passed('multiple attachment previews select each requested file after step-up; missing proof cannot obtain signed URLs; no external storage calls');
}
