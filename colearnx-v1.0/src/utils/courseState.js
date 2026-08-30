export const WATCH_REFUND_LIMIT = 0.1;
export const HOSTED_REFUND_WINDOW_HOURS = 72;
export const LIVE_REFUND_NOTICE_HOURS = 72;

const deliveryLabels = {
  cloud: "Cloud",
  local: "Local",
  live: "Live",
  record: "Record",
};

export function getDeliveryModes(course) {
  if (Array.isArray(course.deliveryModes) && course.deliveryModes.length) {
    return course.deliveryModes;
  }
  if (course.format === "External LIVE") {
    return course.replay ? ["live", "record"] : ["live"];
  }
  return ["cloud"];
}

export function getDeliveryLabel(course) {
  return getDeliveryModes(course)
    .map((mode) => deliveryLabels[mode] || mode)
    .join(" + ");
}

export function getLearningStatus(course) {
  if (course.learningStatus === "Refunded") return "Refunded";
  if (!course.watched) return "Unwatched";
  if (course.watched >= course.duration) return "Watched";
  return "Watching";
}

export function getLiveStatus(course, now = new Date()) {
  if (!getDeliveryModes(course).includes("live") || !course.startsAt)
    return null;
  const start = new Date(course.startsAt);
  const end = new Date(start.getTime() + course.duration * 60 * 1000);
  if (now < start) return "Upcoming";
  if (now < end) return "Live now";
  return "Ended";
}

function hostedPolicyDetail() {
  return `Cloud and eligible Record purchases may be refunded within ${HOSTED_REFUND_WINDOW_HOURS} hours of purchase when viewing progress is ${WATCH_REFUND_LIMIT * 100}% or less.`;
}

function livePolicyDetail() {
  return `Live purchases may be refunded at or before ${LIVE_REFUND_NOTICE_HOURS} hours before the scheduled start. Any included Record follows the Live package policy.`;
}

function localPolicyDetail(delivered) {
  return delivered
    ? "Local delivery is non-refundable. The completed download/access event is recorded as service-delivery evidence."
    : "Local delivery is non-refundable in V1. A completed download/access event is treated as service delivered.";
}

export function getRefundInfo(course, now = new Date()) {
  const modes = getDeliveryModes(course);
  const isLivePackage = modes.includes("live");
  const isLocal = modes.includes("local");
  const recordOnly = modes.length === 1 && modes[0] === "record";

  if (recordOnly) {
    return {
      eligible: false,
      policyPreview: !course.purchased,
      summary: "Independent Record sale disabled",
      detail:
        "Record replay access is available only through its associated Live product until OPEN-016 is resolved.",
    };
  }

  if (isLocal) {
    return {
      eligible: false,
      policyPreview: !course.purchased,
      delivered: Boolean(course.downloaded),
      summary: course.downloaded
        ? "Delivered · non-refundable"
        : "Local · non-refundable",
      detail: localPolicyDetail(Boolean(course.downloaded)),
    };
  }

  if (isLivePackage) {
    if (!course.startsAt) {
      return {
        eligible: false,
        policyPreview: !course.purchased,
        summary: "Schedule required",
        detail:
          "A Live course needs a confirmed start time before enrolment or refund eligibility can be evaluated.",
      };
    }
    const deadline = new Date(
      new Date(course.startsAt).getTime() -
        LIVE_REFUND_NOTICE_HOURS * 60 * 60 * 1000,
    );
    const beforeOrAtDeadline = now <= deadline;
    return {
      eligible: Boolean(course.purchased) && beforeOrAtDeadline,
      policyPreview: !course.purchased,
      deadline,
      summary: !course.purchased
        ? `${LIVE_REFUND_NOTICE_HOURS}-hour Live refund boundary`
        : beforeOrAtDeadline
          ? `Refund by ${deadline.toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short" })}`
          : `${LIVE_REFUND_NOTICE_HOURS}-hour refund deadline passed`,
      detail: livePolicyDetail(),
    };
  }

  const duration = Math.max(1, Number(course.duration) || 1);
  const progress = Math.round(((Number(course.watched) || 0) / duration) * 100);
  const limitPercent = WATCH_REFUND_LIMIT * 100;
  const purchaseDeadline = course.purchasedAt
    ? new Date(
        new Date(course.purchasedAt).getTime() +
          HOSTED_REFUND_WINDOW_HOURS * 60 * 60 * 1000,
      )
    : null;
  const withinPurchaseWindow = purchaseDeadline
    ? now <= purchaseDeadline
    : false;
  const withinProgressLimit = progress <= limitPercent;

  if (!course.purchased) {
    return {
      eligible: false,
      policyPreview: true,
      progress,
      purchaseDeadline: null,
      summary: `${HOSTED_REFUND_WINDOW_HOURS} hours · up to ${limitPercent}% watched`,
      detail: hostedPolicyDetail(),
    };
  }

  if (!purchaseDeadline) {
    return {
      eligible: false,
      policyPreview: false,
      progress,
      purchaseDeadline: null,
      summary: "Purchase timestamp unavailable",
      detail:
        "Refund eligibility must be calculated by the API from the policy snapshot and authoritative purchase timestamp.",
    };
  }

  return {
    eligible: withinPurchaseWindow && withinProgressLimit,
    policyPreview: false,
    progress,
    purchaseDeadline,
    summary: !withinPurchaseWindow
      ? `${HOSTED_REFUND_WINDOW_HOURS}-hour purchase window passed`
      : !withinProgressLimit
        ? `${progress}% watched · ${limitPercent}% limit`
        : `Eligible until ${purchaseDeadline.toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short" })}`,
    detail: hostedPolicyDetail(),
  };
}
