type ProductPolicyInput = {
  kind: 'course' | 'content';
  deliveryModes: string[];
  startsAt: Date | null;
  totalDurationSeconds: number | null;
};

/** Keep the pre-purchase disclosure and the recorded purchase policy in sync. */
export function purchaseRefundPolicyPreview(kind: 'course' | 'content', deliveryModes: unknown = []) {
  const modes = Array.isArray(deliveryModes) ? deliveryModes : [];
  if (kind === 'course' && modes.some((mode) => mode === 'local' || mode === 'live')) {
    return { rule: 'self-arranged-72h-v1', noticeHours: 72, summary: 'Self-arranged online or offline courses may be refunded only when requested at least 72 hours before the course starts.' };
  }
  return { rule: 'recorded-media-10pct-no-download-v1', watchedRatioMaximum: 0.1, requiresNoDownload: true, summary: 'Recorded video or file refunds require viewing at or below 10% and no protected file download.' };
}

export function refundPolicySnapshot(product: ProductPolicyInput, purchasedAt: Date) {
  const policy = purchaseRefundPolicyPreview(product.kind, product.deliveryModes);
  const base = { purchasedAt: purchasedAt.toISOString(), deliveryModes: product.deliveryModes, ...policy };
  return policy.rule === 'self-arranged-72h-v1'
    ? { ...base, startsAt: product.startsAt?.toISOString() ?? null }
    : { ...base, totalDurationSeconds: product.totalDurationSeconds };
}
