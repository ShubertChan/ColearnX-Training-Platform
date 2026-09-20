import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Called only after the parent harness verifies an isolated, local PG16 cluster.
export async function runVideoOrderIntegrityChecks({ owner, buyerId, sellerId, courseId, courseRunId, passed }) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    const otherRunId = randomUUID();
    await client.query(`INSERT INTO course_runs (course_run_id, course_id, run_code, price_points, primary_delivery_type)
      VALUES ($1, $2, $3, 250, 'cloud')`, [otherRunId, courseId, `integrity-${otherRunId}`]);
    const versionIds = [randomUUID(), randomUUID()];
    for (const [index, versionId] of versionIds.entries()) {
      const assetId = randomUUID();
      await client.query(`INSERT INTO course_delivery_assets
        (course_delivery_asset_id, course_run_id, owner_user_id, asset_purpose, bucket_name, object_key,
         original_filename, declared_content_type, declared_byte_size, upload_expires_at)
        VALUES ($1, $2, $3, 'video_source', 'fixture-private', $4, 'fixture.mp4', 'video/mp4', 10, now() + interval '1 hour')`,
      [assetId, courseRunId, sellerId, `fixture/${assetId}`]);
      await client.query(`INSERT INTO course_video_versions (course_video_version_id, course_run_id, source_asset_id, version_no)
        VALUES ($1, $2, $3, $4)`, [versionId, courseRunId, assetId, index + 1]);
    }
    const orderId = randomUUID(); const itemId = randomUUID();
    await client.query(`INSERT INTO orders (order_id, buyer_user_id, order_no, total_points) VALUES ($1,$2,$3,250)`, [orderId, buyerId, `integrity-${orderId}`]);
    await client.query('SET LOCAL ROLE colearnx_app');
    const insert = `INSERT INTO order_items (order_item_id, order_id, item_type, course_run_id, seller_user_id, item_title_snapshot, points_amount, course_video_version_id)
      VALUES ($1,$2,'course_run',$3,$4,'Video fixture',250,$5)`;
    await client.query(insert, [itemId, orderId, courseRunId, sellerId, versionIds[0]]);
    const reject = async (sql, values, code) => {
      await client.query('SAVEPOINT expected_rejection');
      await assert.rejects(client.query(sql, values), error => error.code === code);
      await client.query('ROLLBACK TO SAVEPOINT expected_rejection');
      await client.query('RELEASE SAVEPOINT expected_rejection');
    };
    await reject(insert, [randomUUID(), orderId, otherRunId, sellerId, versionIds[0]], '23503');
    await reject('UPDATE order_items SET course_video_version_id=$1 WHERE order_item_id=$2', [versionIds[1], itemId], '55000');
    await reject('UPDATE order_items SET course_video_version_id=NULL WHERE order_item_id=$1', [itemId], '55000');
    await client.query('UPDATE order_items SET course_video_version_id=$1 WHERE order_item_id=$2', [versionIds[0], itemId]);
    assert.equal((await client.query('SELECT course_video_version_id FROM order_items WHERE order_item_id=$1', [itemId])).rows[0].course_video_version_id, versionIds[0]);
    passed('017 runtime role accepts matching video orders, rejects cross-course bindings and rebinding/removal, and allows a no-op update');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
