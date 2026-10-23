const presentation = {
  pending: { label: "Refund under review", description: "Your request is waiting for administrator review. No points have been refunded yet.", tone: "warning", blocksRequest: true },
  approved: { label: "Refund approved", description: "Your request was approved. Refresh your order to confirm the completed refund.", tone: "info", blocksRequest: true },
  refunded: { label: "Refunded", description: "The refund is complete. The points have been returned to your wallet.", tone: "success", blocksRequest: true },
  rejected: { label: "Refund rejected", description: "Your request was not approved. No points were refunded.", tone: "danger", blocksRequest: false },
  cancelled: { label: "Refund request cancelled", description: "This refund request was cancelled. No points were refunded.", tone: "neutral", blocksRequest: false },
};

export function refundStatus(item) {
  const records = (Array.isArray(item?.refundRecords) ? item.refundRecords : []).filter(Boolean);
  const record = records.reduce((latest, next) => !latest || (Date.parse(next.requestedAt) || 0) > (Date.parse(latest.requestedAt) || 0) ? next : latest, null);
  const code = item?.fulfilmentStatus === "refunded" ? "refunded" : String(record?.status || "").toLowerCase();
  if (!record && code !== "refunded") return null;
  return { code: presentation[code] ? code : "unknown", record, ...(presentation[code] || { label: "Refund status unavailable", description: "Refresh your order to check the latest refund status before submitting another request.", tone: "neutral", blocksRequest: true }) };
}
