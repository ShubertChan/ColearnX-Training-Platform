export const VIDEO_REFUND_PROGRESS_LIMIT = 0.1;
import { isVideoCourse } from "./coursePresentation.js";

const normaliseModes = (value) =>
  (Array.isArray(value) ? value : []).map((mode) => String(mode).toLowerCase());

export function deliveryDisclosures(item = {}) {
  const modes = normaliseModes(item.deliveryModes);
  const disclosures = [];
  const videoCourse = isVideoCourse(item);
  if (item.kind === "content" || item.contentVersionId || item.type) {
    disclosures.push("Digital resource: open My Learning after purchase to request a short-lived, authorised download link.");
  }
  if (videoCourse) {
    disclosures.push("Video course: watch in My Learning; no video download is offered. If you have watched no more than 10% of unique video content and have not downloaded protected attachments, you may request a full points refund for the order item. Exactly 10% is included. The service confirms eligibility.");
  } else if (modes.includes("cloud")) {
    disclosures.push("Course files: download protected course files from My Learning through a short-lived, purchase-authorised link.");
  }
  if (modes.includes("local")) {
    disclosures.push("Instructor-led course — offline arrangement: you and the Trainer arrange fulfilment yourselves. The course announcement and contact details appear after payment.");
  }
  if (modes.includes("live")) {
    disclosures.push("Instructor-led course — online live session: you and the Trainer arrange the session yourselves. The course announcement, contact and optional live-session link appear after payment.");
  }
  return disclosures.length
    ? disclosures
    : ["The server will return the delivery channel and purchase-time refund policy before payment."];
}

export function refundDisclosure(item = {}) {
  return policyText(item) || "The exact refund terms are unavailable. Checkout is paused until the service provides them.";
}

export function policyText(item = {}) {
  const policy = item.purchased ? item.refundPolicySnapshot || item.refundPolicy : item.refundPolicyPreview || item.refundPolicySnapshot || item.refundPolicy || item.refundPolicySummary;
  const text = typeof policy === "string" ? policy : policy?.summary || policy?.description;
  return typeof text === "string" ? text.trim() : "";
}

export const hasPurchasePolicy = (item) => Boolean(policyText(item));

export function cartItemKey(item) {
  return `${item.kind}:${item.id}`;
}
