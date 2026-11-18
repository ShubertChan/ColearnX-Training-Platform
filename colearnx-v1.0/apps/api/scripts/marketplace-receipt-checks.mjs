import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

export async function runMarketplaceReceiptChecks({ owner, app, buyerId, sellerId, accessToken, passed }) {
  const course = randomUUID(), run = randomUUID(), content = randomUUID(), version = randomUUID();
  const otherRun = randomUUID(), oldVersion = randomUUID();
  await owner.query("INSERT INTO courses(course_id,owner_user_id,title,publication_status) VALUES ($1,$2,'Marketreceipt workshop','published')", [course,sellerId]);
  for (const id of [run, otherRun]) {
    await owner.query("INSERT INTO course_runs(course_run_id,course_id,run_code,run_status,price_points,primary_delivery_type) VALUES ($1,$2,$3,'published',20,'live')", [id,course,id]);
  }
  await owner.query("INSERT INTO contents(content_id,creator_user_id,title,content_type,price_points,publication_status) VALUES ($1,$2,'Marketreceipt workbook','digital',10,'published')", [content,sellerId]);
  await owner.query("INSERT INTO content_versions(content_version_id,content_id,version_no,version_status,published_at) VALUES ($1,$2,1,'retired',now()),($3,$2,2,'published',now())", [oldVersion,content,version]);

  async function activity(path, id, sales, downloads) {
    const expected = { sales, downloads };
    const listed = await request(app).get('/api/v1/' + path).query({ q: 'marketreceipt' }).expect(200);
    const detail = await request(app).get('/api/v1/' + path + '/' + id).expect(200);
    assert.deepEqual(listed.body.data.find(row => row.id === id)?.activity, expected);
    assert.deepEqual(detail.body.data.activity, expected);
  }
  async function order(isPaid) {
    const id = randomUUID();
    await owner.query(`INSERT INTO orders(order_id,buyer_user_id,order_no,total_points,order_status,paid_at)
      VALUES ($1,$2,$3,30,$4,$5)`, [id,buyerId,id,isPaid ? 'paid' : 'pending',isPaid ? new Date() : null]);
    return id;
  }
  async function item(orderId, runId, versionId, status) {
    const id = randomUUID();
    await owner.query(`INSERT INTO order_items(order_item_id,order_id,item_type,course_run_id,content_version_id,seller_user_id,item_title_snapshot,points_amount,fulfilment_status)
      VALUES ($1,$2,$3,$4,$5,$6,'Fixture',$7,$8)`,
    [id,orderId,runId ? 'course_run' : 'content_version',runId,versionId,sellerId,runId ? 20 : 10,status]);
    return id;
  }
  async function posting(line, type) {
    const id = randomUUID();
    await owner.query("INSERT INTO point_transactions(point_transaction_id,order_item_id,transaction_type,reason) VALUES ($1,$2,$3,'Receipt fixture')", [id,line,type]);
    return id;
  }
  await activity('courses', run, 0, 0);
  await activity('content', version, 0, 0);
  const paid = await order(true), unpaid = await order(false);
  const courseItem = await item(paid, run, null, 'reserved');
  const workbookItem = await item(paid, null, version, 'fulfilled');
  await item(paid, null, oldVersion, 'fulfilled');
  await item(paid, null, version, 'cancelled');
  await item(unpaid, run, null, 'paid');
  const hold = await posting(courseItem, 'live_hold'), debit = await posting(workbookItem, 'purchase');
  const enrolment = randomUUID();
  await owner.query("INSERT INTO course_enrolments(enrolment_id,course_run_id,learner_user_id,order_item_id,enrolment_status) VALUES ($1,$2,$3,$4,'confirmed')", [enrolment,run,buyerId,courseItem]);
  for (const mode of ['cloud','record']) {
    const option = randomUUID();
    await owner.query("INSERT INTO course_delivery_options(delivery_option_id,course_run_id,delivery_type,access_mode) VALUES ($1,$2,$3,'on_demand')", [option,run,mode]);
  }
  // The release harness disables storage. An unsuccessful link request must
  // leave both the refund evidence and public downloads at zero.
  const asset = randomUUID();
  await owner.query(`INSERT INTO course_delivery_assets(course_delivery_asset_id,course_run_id,owner_user_id,asset_purpose,
    bucket_name,object_key,original_filename,declared_content_type,declared_byte_size,verified_byte_size,verified_content_type,verified_at,asset_status,upload_expires_at)
    VALUES ($1,$2,$3,'cloud_download','fixture','fixture/guide.pdf','guide.pdf','application/pdf',10,10,'application/pdf',now(),'ready',now()+interval '1 hour')`, [asset,run,sellerId]);
  await request(app).post('/api/v1/order-items/' + courseItem + '/delivery/download-url')
    .auth(accessToken(buyerId), { type: 'bearer' }).send({ assetId: asset }).expect(503);
  await activity('courses', run, 1, 0);
  await owner.query(`INSERT INTO course_access_progress(enrolment_id,delivery_option_id,download_completed_at)
    SELECT $1,delivery_option_id,now() FROM course_delivery_options WHERE course_run_id=$2`, [enrolment,run]);
  await owner.query("INSERT INTO content_access_grants(content_version_id,user_id,order_item_id,grant_reason,first_accessed_at) VALUES ($1,$2,$3,'purchase',now())", [version,buyerId,workbookItem]);
  await activity('courses', run, 1, 1);
  await activity('courses', otherRun, 0, 0);
  await activity('content', version, 1, 1);
  await owner.query("UPDATE order_items SET fulfilment_status='refunded' WHERE order_item_id=$1", [courseItem]);
  await posting(courseItem, 'refund');
  await activity('courses', run, 0, 0);
  await activity('content', version, 1, 1);
  const receipt = await request(app).get('/api/v1/orders/' + paid).auth(accessToken(buyerId), { type: 'bearer' }).expect(200);
  const references = new Map(receipt.body.data.items.map(row => [row.id,row.transactionReference]));
  assert.equal(references.get(courseItem), hold);
  assert.equal(references.get(workbookItem), debit);
  passed('published listing counts isolate versions and runs, exclude unpaid and reversed items, and count repeated downloads once');
  passed('historical mixed-order receipts retain the original purchase and live reservation postings after a refund');
  passed('a failed course-file signature leaves download and refund evidence unchanged');
}
