// Invoked by release-integration-check only after its PG16 isolation checks and migrations.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { beginEnrolment, confirmEnrolment } from '../src/auth/mfa/service.ts';
import { totpCodeForStep, totpStep } from '../src/auth/mfa/totp.ts';
import { issueChallenge } from '../src/auth/mfa/challenge.ts';
import { ipFingerprint } from '../src/security/fingerprint.ts';

export async function runSecurityRegression({ owner, app, sellerId, versionId, accessToken, environment, runJob, passed }) {
  const ip = '192.0.2.211';
  const reset = address => request(app).post('/api/v1/auth/forgot-password').set('X-Forwarded-For', address).send({});
  for (let i = 0; i < 5; i++) await reset(ip).expect(400);
  // Only the nearest forwarded hop is trusted. Rotating a client-supplied prefix must not reset the quota.
  const denied = await reset('192.0.2.19, ' + ip).expect(429);
  assert.equal(denied.body.error.code, 'RATE_LIMITED');
  await reset('192.0.2.212').expect(400);
  const eventId = denied.body.error.requestId;
  // Access-decision writes are asynchronous. Poll for this request only.
  let event;
  for (let i = 0; i < 100 && !event; i++) {
    event = (await owner.query('SELECT * FROM security_events WHERE request_id=$1 AND event_type=$2',
      [eventId, 'access.rate_limited'])).rows[0];
    if (!event) await delay(20);
  }
  assert.equal(event?.decision, 'deny');
  assert.equal(event.actor_ip_hash, ipFingerprint(ip, environment.SECURITY_HASH_PEPPER));
  assert.equal(denied.headers['strict-transport-security'], 'max-age=63072000; includeSubDomains; preload');
  passed('W5: a single proxy source exhausts the reset quota; another stays usable, HSTS is set, and the 429 is fingerprinted in PostgreSQL');

  const events = token => request(app).get('/api/v1/admin/security/events?type=access.rate_limited').auth(token, { type: 'bearer' });
  await events(accessToken(sellerId)).expect(403);
  const adminId = randomUUID(), sid = randomUUID(), email = adminId + '@example.test';
  await owner.query("INSERT INTO users(user_id,full_name,email,password_hash) VALUES($1,'W9 admin',$2,'no-login')", [adminId, email]);
  await owner.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,role_id FROM roles WHERE role_code='admin'", [adminId]);
  await owner.query("INSERT INTO refresh_sessions(session_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
    [sid, adminId, createHash('sha256').update(randomUUID()).digest('hex')]);
  const token = jwt.sign({ sub: adminId, sid }, environment.ACCESS_TOKEN_SECRET, { expiresIn: '5m' });
  const before = await events(token).expect(403);
  assert.equal(before.body.error.code, 'MFA_ENROLMENT_REQUIRED');
  const enrollment = await beginEnrolment(adminId, email);
  assert.equal((await confirmEnrolment(adminId, totpCodeForStep(enrollment.secret, totpStep(Date.now())))).status, 'confirmed');
  assert.equal((await events(token).expect(401)).body.error.code, 'STEP_UP_REQUIRED');
  const step = issueChallenge('step-up', adminId, 300, environment.MFA_CHALLENGE_SECRET, Date.now(), jwt.decode(token).sid);
  const feed = await events(token).set('X-Step-Up-Token', step).expect(200);
  const row = feed.body.data.find(item => item.requestId === eventId);
  assert.equal(row?.source, event.actor_ip_hash.slice(0, 12));
  assert.ok(!JSON.stringify(row).includes(ip));
  passed('W6: member and insufficiently verified admin cannot read the event; a session-bound step-up reveals only its short source fingerprint');

  // Inject a historical self-dealing order (normal checkout should never create it).
  const orderId = randomUUID();
  await owner.query('INSERT INTO orders(order_id,buyer_user_id,order_no,total_points) VALUES($1,$2,$3,125)',
    [orderId, sellerId, 'risk-' + orderId]);
  await owner.query(`INSERT INTO order_items(order_id,item_type,content_version_id,seller_user_id,item_title_snapshot,points_amount)
    VALUES($1,'content_version',$2,$3,'risk fixture',125)`, [orderId, versionId, sellerId]);
  const actor = randomUUID();
  await owner.query(`INSERT INTO users(user_id,full_name,email,password_hash) VALUES($1,'Ledger fixture',$2,'no-login')`, [actor, actor + '@example.test']);
  await owner.query('INSERT INTO point_accounts(user_id,available_balance) VALUES($1,7)', [actor]);
  for (let i = 0; i < 3; i++) {
    const refundOrder = randomUUID(), item = randomUUID();
    await owner.query('INSERT INTO orders(order_id,buyer_user_id,order_no,total_points) VALUES($1,$2,$3,125)', [refundOrder, actor, 'refund-' + refundOrder]);
    await owner.query(`INSERT INTO order_items(order_item_id,order_id,item_type,content_version_id,seller_user_id,item_title_snapshot,points_amount)
      VALUES($1,$2,'content_version',$3,$4,'refund fixture',125)`, [item, refundOrder, versionId, sellerId]);
    await owner.query(`INSERT INTO refund_requests(order_item_id,requested_by_user_id,requested_points,refund_reason,eligibility_snapshot_json)
      VALUES($1,$2,125,'Fixture refund','{}')`, [item, actor]);
  }
  for (const script of ['src/security/risk-sweep-run.ts', 'src/security/ledger-audit-run.ts']) {
    const run = await runJob(script);
    assert.equal(run.code, 0, run.stderr);
  }
  const risk = await owner.query(`SELECT risk_score,rule_hits FROM security_events
    WHERE actor_user_id=$1 AND event_type='finance.risk_flagged'`, [sellerId]);
  assert.ok(risk.rows.some(e => e.risk_score >= 60 && e.rule_hits.includes('self_purchase')));
  const refunds = await owner.query(`SELECT risk_score,rule_hits FROM security_events
    WHERE actor_user_id=$1 AND event_type='finance.risk_flagged'`, [actor]);
  assert.ok(refunds.rows.some(e => e.risk_score === 60 && e.rule_hits.includes('rapid_refund') && e.rule_hits.includes('refund_velocity')));
  const drift = await owner.query(`SELECT context_json FROM security_events WHERE actor_user_id=$1 AND event_type='finance.ledger_imbalance'`, [actor]);
  assert.ok(drift.rows.some(e => e.context_json.discrepancies.some(d => d.field === 'available' && d.delta === 7)));
  passed('W7: restricted-role jobs find self-purchase, refund velocity, rapid refunds and an exact seven-point discrepancy');
}
