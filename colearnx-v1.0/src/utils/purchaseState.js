const activeFulfilmentStatuses = new Set(["paid", "reserved", "fulfilled"]);

// A missing status is deliberately not treated as ownership. The client may
// only unlock an item when the order-detail API reports a known active status.
export const isActivePurchase = (fulfilmentStatus) => activeFulfilmentStatuses.has(fulfilmentStatus);

export function purchaseMetadataByProduct(orders, kind) {
  const purchases = new Map();
  orders.forEach((order) => (order.items || []).forEach((item) => {
    if (item.kind !== kind || !item.productId || !isActivePurchase(item.fulfilmentStatus)) return;
    const candidate = { purchased: true, purchasedAt: order.paidAt || order.createdAt, orderItemId: item.id, orderId: order.id, refundStatus: null };
    const current = purchases.get(item.productId);
    if (!current || String(candidate.purchasedAt || "") >= String(current.purchasedAt || "")) purchases.set(item.productId, candidate);
  }));
  return purchases;
}

export function decoratePurchasedItems(items, purchases) {
  return items.map((item) => {
    const purchase = purchases.get(item.id);
    if (purchase) return { ...item, ...purchase };
    const { purchasedAt, orderItemId, orderId, refundStatus, ...catalogItem } = item;
    return { ...catalogItem, purchased: false };
  });
}
