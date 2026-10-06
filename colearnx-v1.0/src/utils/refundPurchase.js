const activeStatuses = new Set(["paid", "reserved", "fulfilled"]);

export function refundReasonError(reason) {
  const length = reason.trim().length;
  if (length < 3) return "Enter at least 3 characters for the refund reason.";
  if (length > 2000) return "The refund reason must be no more than 2000 characters.";
  return "";
}

export function refundPurchase(orders, productId, orderItemId) {
  const items = orders.flatMap(order => order.items || []).filter(item =>
    item.kind === "course" && item.productId === productId && activeStatuses.has(item.fulfilmentStatus));
  const item = orderItemId ? items.find(item => item.id === orderItemId) : items[0];
  return item ? { ...item, id: item.productId, orderItemId: item.id, purchased: true } : null;
}

export function refundReviewEvidence(request) {
  const evidence = request.eligibilitySnapshot ?? { ...request.evidence,
    refundEligibility: request.evidence?.refundEligibility ?? request.eligibility };
  const eligibility = evidence?.refundEligibility ?? evidence?.eligibility;
  return { evidence, serverEligible: eligibility?.eligible };
}
