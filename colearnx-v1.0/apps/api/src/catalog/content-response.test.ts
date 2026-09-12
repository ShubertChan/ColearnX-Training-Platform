import assert from 'node:assert/strict';
import test from 'node:test';
import { contentResponse } from './content-response.js';
import { purchaseRefundPolicyPreview } from '../refunds/purchase-policy.js';

test('catalogue content exposes the policy required by the buyer UI without leaking private asset fields', () => {
  const response = contentResponse({ content_version_id: 'version', content_id: 'content', title: 'Resource',
    price_points: '50', creator_user_id: 'creator', owner_name: 'Creator', category_id: null,
    object_key: 'private/key', bucket_name: 'private-bucket' });
  assert.equal(response.id, 'version');
  assert.equal(response.contentId, 'content');
  assert.equal(response.pricePoints, 50);
  assert.deepEqual(response.refundPolicyPreview, purchaseRefundPolicyPreview('content'));
  assert.ok(response.refundPolicyPreview.summary);
  assert.equal('object_key' in response, false);
  assert.equal('bucket_name' in response, false);
});
