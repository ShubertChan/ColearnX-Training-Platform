import { purchaseRefundPolicyPreview } from '../refunds/purchase-policy.js';

export function contentResponse(row: Record<string, unknown>) {
  return {
    id: row.content_version_id, contentId: row.content_id, title: row.title, description: row.description,
    contentType: row.content_type, pricePoints: Number(row.price_points), status: row.publication_status,
    publishedAt: row.published_at,
    owner: { id: row.creator_user_id, displayName: row.owner_name },
    category: row.category_id ? { id: row.category_id, name: row.category_name } : null,
    refundPolicyPreview: purchaseRefundPolicyPreview('content'),
  };
}
