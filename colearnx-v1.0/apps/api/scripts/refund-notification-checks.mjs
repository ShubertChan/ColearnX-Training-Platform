// Invoked only by the release harness after it verifies an isolated local PG16 cluster.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import request from 'supertest';

export async function runRefundNotificationChecks({ owner, app, environment, buyerId, sellerId, adminId, courseRunId, accessToken, passed }) {
  const { recordRefundNotification } = await import('../src/refunds/notifications.ts');
  const { refundNotificationChannel, refundNotificationEvents } = await import('../src/refunds/notification-events.ts');
  const { beginEnrolment, confirmEnrolment } = await import('../src/auth/mfa/service.ts');
  const { totpCodeForStep, totpStep } = await import('../src/auth/mfa/totp.ts');
  const pendingMfa = await beginEnrolment(adminId, 'admin@example.test');
  await confirmEnrolment(adminId, totpCodeForStep(pendingMfa.secret, totpStep(Date.now())));
  await owner.query(`INSERT INTO point_accounts(user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [buyerId]);
  await owner.query(`INSERT INTO point_accounts(account_status) SELECT 'system'
    WHERE NOT EXISTS (SELECT 1 FROM point_accounts WHERE account_status='system')`);
  const balance = async () => Number((await owner.query('SELECT available_balance FROM point_accounts WHERE user_id=$1', [buyerId])).rows[0].available_balance);
  const startingBalance = await balance();
  const getUnread = (userId = buyerId) => request(app).get('/api/v1/notifications/refunds').auth(accessToken(userId), { type: 'bearer' });
  const decide = (id, decision) => request(app).post(`/api/v1/admin/refund-requests/${id}/decision`)
    .auth(accessToken(adminId), { type: 'bearer' }).set('X-Forwarded-For', '192.0.2.90').send({ decision, reason: `Reviewed ${decision} request` });
  const acknowledge = (id, userId = buyerId) => request(app).post(`/api/v1/notifications/refunds/${id}/read`)
    .auth(accessToken(userId), { type: 'bearer' }).set('X-Forwarded-For', '192.0.2.91').send({});
  async function pendingRefund() {
    const orderId = randomUUID(), itemId = randomUUID(), id = randomUUID();
    await owner.query(`INSERT INTO orders(order_id,buyer_user_id,order_no,total_points) VALUES($1,$2,$3,100)`, [orderId, buyerId, `refund-${orderId}`]);
    await owner.query(`INSERT INTO order_items(order_item_id,order_id,item_type,course_run_id,seller_user_id,item_title_snapshot,points_amount,fulfilment_status)
      VALUES($1,$2,'course_run',$3,$4,'Refund integration course',100,'fulfilled')`, [itemId, orderId, courseRunId, sellerId]);
    await owner.query(`INSERT INTO refund_requests(refund_request_id,order_item_id,requested_by_user_id,requested_points,refund_reason,eligibility_snapshot_json)
      VALUES($1,$2,$3,100,'Please review this request','{"eligible":true,"deliveryModes":["cloud"]}')`, [id, itemId, buyerId]);
    return id;
  }

  const observer = new Client({ connectionString: environment.DATABASE_URL });
  const events = [];
  observer.on('notification', message => events.push(message.payload));
  await observer.connect();
  await observer.query(`LISTEN ${refundNotificationChannel}`);
  try {
    await request(app).get('/api/v1/notifications/refunds').expect(401);
    const subscription = refundNotificationEvents.subscribe(buyerId, () => {});
    assert.equal(await subscription.ready, true); subscription.dispose();
    const approvedId = await pendingRefund();
    let delivered = false;
    const waiting = request(app).get('/api/v1/notifications/refunds?wait=1').auth(accessToken(buyerId), { type: 'bearer' })
      .timeout({ deadline: 5000 }).then(response => { delivered = true; return response; });
    await delay(100);
    assert.equal(delivered, false, 'An empty online mailbox must wait for a decision');
    await decide(approvedId, 'approved').expect(200);
    const online = await waiting;
    assert.equal(online.status, 200);
    assert.equal(online.headers['cache-control'], 'no-store');
    assert.equal(online.body.data[0].refundRequestId, approvedId);
    assert.equal(online.body.data[0].status, 'approved');
    assert.equal(online.body.data[0].points, 100);
    assert.equal(await balance(), startingBalance + 100);
    assert.equal((await owner.query('SELECT count(*)::int AS count FROM point_transactions WHERE refund_request_id=$1', [approvedId])).rows[0].count, 1);
    assert.deepEqual(events, [buyerId]);
    const noticeId = online.body.data[0].id;
    assert.equal((await getUnread(sellerId).expect(200)).body.data.length, 0);
    await acknowledge(noticeId, sellerId).expect(404);
    assert.equal((await getUnread().expect(200)).body.data.length, 1);
    await decide(approvedId, 'approved').expect(409);
    assert.equal(await balance(), startingBalance + 100);
    await acknowledge(noticeId).expect(200);
    await acknowledge(noticeId).expect(200);
    assert.equal((await getUnread().expect(200)).body.data.length, 0);
    passed('020 approved refund atomically credits points, wakes a real HTTP long poll through PostgreSQL NOTIFY, scopes reads/acks to the buyer, and rejects duplicate decisions');

    const rejectedId = await pendingRefund();
    const rollback = await owner.connect();
    try {
      await rollback.query('BEGIN');
      await recordRefundNotification(rollback, { userId: buyerId, refundRequestId: rejectedId, title: 'Rolled back', reason: 'Must not be delivered' });
      assert.equal((await getUnread().expect(200)).body.data.length, 0);
      await delay(50);
      assert.deepEqual(events, [buyerId], 'Uncommitted NOTIFY must stay invisible');
      await rollback.query('ROLLBACK');
    } finally { rollback.release(); }
    assert.equal((await owner.query('SELECT 1 FROM notifications WHERE refund_request_id=$1', [rejectedId])).rowCount, 0);
    await decide(rejectedId, 'rejected').expect(200); // No member request is listening.
    const offline = (await getUnread().expect(200)).body.data;
    assert.equal(offline.length, 1);
    assert.equal(offline[0].status, 'rejected');
    assert.equal(offline[0].decisionReason, 'Reviewed rejected request');
    assert.equal(await balance(), startingBalance + 100);
    assert.equal((await getUnread().expect(200)).body.data[0].id, offline[0].id, 'Loading a popup must not mark it read');
    await acknowledge(offline[0].id).expect(200);
    passed('020 rollback leaves no durable notification or broadcast; an offline rejection persists across authenticated reads until explicit confirmation, without crediting points');

    const failureId = await pendingRefund();
    // Force an actual PostgreSQL error at notification insertion, after ledger work.
    await owner.query(`CREATE FUNCTION fail_refund_notice_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic notification failure'; END $$`);
    await owner.query(`CREATE TRIGGER fail_refund_notice_test BEFORE INSERT ON notifications
      FOR EACH ROW EXECUTE FUNCTION fail_refund_notice_test()`);
    try { await decide(failureId, 'approved').expect(500); }
    finally {
      await owner.query('DROP TRIGGER fail_refund_notice_test ON notifications');
      await owner.query('DROP FUNCTION fail_refund_notice_test()');
    }
    assert.equal((await owner.query('SELECT refund_status FROM refund_requests WHERE refund_request_id=$1', [failureId])).rows[0].refund_status, 'pending');
    assert.equal((await owner.query('SELECT 1 FROM point_transactions WHERE refund_request_id=$1', [failureId])).rowCount, 0);
    assert.equal((await owner.query('SELECT 1 FROM notifications WHERE refund_request_id=$1', [failureId])).rowCount, 0);
    assert.equal(await balance(), startingBalance + 100);
    await decide(failureId, 'approved').expect(200);
    assert.equal(await balance(), startingBalance + 200);
    passed('020 a real notification INSERT failure rolls back the refund, financial ledger and balance; retry succeeds exactly once');
  } finally {
    await observer.end();
    await refundNotificationEvents.close();
  }
}
