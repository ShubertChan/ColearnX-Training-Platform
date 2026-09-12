export const WATCH_REFUND_LIMIT = 0.1;
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

function recordedMediaPolicyDetail() {
  return `Recorded video or file refunds require viewing of ${WATCH_REFUND_LIMIT * 100}% or less and no protected-file download.`;
}

function selfArrangedPolicyDetail() {
  return `Self-arranged online or offline courses may be refunded only at or before ${LIVE_REFUND_NOTICE_HOURS} hours before the scheduled start.`;
}

export function getRefundInfo(course, now = new Date()) {
  const modes = getDeliveryModes(course);
  const isSelfArranged = modes.includes("local") || modes.includes("live");

  if (isSelfArranged) {
    if (!course.startsAt) {
      return {
        eligible: false,
        policyPreview: !course.purchased,
        summary: "Schedule required",
        detail:
          "A self-arranged course needs a confirmed start time before refund eligibility can be evaluated.",
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
        ? `${LIVE_REFUND_NOTICE_HOURS}-hour self-arranged refund boundary`
        : beforeOrAtDeadline
          ? `Refund by ${deadline.toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short" })}`
          : `${LIVE_REFUND_NOTICE_HOURS}-hour self-arranged refund deadline passed`,
      detail: selfArrangedPolicyDetail(),
    };
  }

  const duration = Math.max(1, Number(course.duration) || 1);
  const progress = Math.round(((Number(course.watched) || 0) / duration) * 100);
  const limitPercent = WATCH_REFUND_LIMIT * 100;
  const downloaded = Boolean(course.downloaded);
  const withinProgressLimit = progress <= limitPercent;

  if (!course.purchased) {
    return {
      eligible: false,
      policyPreview: true,
      progress,
      downloaded,
      summary: `Recorded media · up to ${limitPercent}% watched · no download`,
      detail: recordedMediaPolicyDetail(),
    };
  }

  return {
    eligible: !downloaded && withinProgressLimit,
    policyPreview: false,
    progress,
    downloaded,
    summary: downloaded
      ? "Protected file downloaded · refund unavailable"
      : !withinProgressLimit
        ? `${progress}% watched · ${limitPercent}% limit`
        : `Eligible · ${progress}% watched · no download`,
    detail: recordedMediaPolicyDetail(),
  };
}
