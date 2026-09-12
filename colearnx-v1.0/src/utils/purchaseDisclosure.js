export const VIDEO_REFUND_PROGRESS_LIMIT = 0.1;

const normaliseModes = (value) =>
  (Array.isArray(value) ? value : []).map((mode) => String(mode).toLowerCase());

export function deliveryDisclosures(item = {}) {
  const modes = normaliseModes(item.deliveryModes);
  const disclosures = [];
  if (item.kind === "content" || item.contentVersionId || item.type) {
    disclosures.push("Digital resource: open My Learning after purchase to request a short-lived, authorised download link.");
  }
  if (modes.includes("cloud")) {
    disclosures.push("Cloud: download the course files from My Learning through a short-lived, purchase-authorised link.");
  }
  if (modes.includes("local")) {
    disclosures.push("Local: you and the Trainer arrange fulfilment yourselves. Buyer-only instructions and contact details appear after payment.");
  }
  if (modes.includes("live")) {
    disclosures.push("Live: you and the Trainer arrange the session yourselves. Buyer-only contact and optional meeting/group links appear after payment.");
  }
  if (item.onlineVideo || item.progressTrackingType === "online_video") {
    disclosures.push("Online video: the server records actual watched time and total duration. The viewing-progress refund condition is met only at 10% watched or less.");
  }
  return disclosures.length
    ? disclosures
    : ["The server will return the delivery channel and purchase-time refund policy before payment."];
}

export function refundDisclosure(item = {}) {
  return policyText(item) || "The exact refund terms are unavailable. Checkout is paused until the service provides them.";
}

export function policyText(item = {}) {
  const policy = item.refundPolicyPreview || item.refundPolicySnapshot || item.refundPolicy || item.refundPolicySummary;
  const text = typeof policy === "string" ? policy : policy?.summary || policy?.description;
  return typeof text === "string" ? text.trim() : "";
}

export const hasPurchasePolicy = (item) => Boolean(policyText(item));

export function cartItemKey(item) {
  return `${item.kind}:${item.id}`;
}
