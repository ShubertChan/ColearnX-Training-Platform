export const WATCH_REFUND_LIMIT = 0.1;

const deliveryLabels = { cloud: "Cloud", local: "Local", live: "Live" };

export function getDeliveryModes(course) {
  if (Array.isArray(course.deliveryModes) && course.deliveryModes.length) return course.deliveryModes;
  if (course.format === "External LIVE") return ["live"];
  return ["cloud"];
}

export function getDeliveryLabel(course) {
  return getDeliveryModes(course).map((mode) => deliveryLabels[mode] || mode).join(" + ");
}

export function getLearningStatus(course) {
  if (course.learningStatus === "Refunded") return "Refunded";
  if (!course.watched) return "Unwatched";
  if (course.watched >= course.duration) return "Watched";
  return "Watching";
}

export function getLiveStatus(course, now = new Date()) {
  if (!getDeliveryModes(course).includes("live") || !course.startsAt) return null;
  const start = new Date(course.startsAt);
  const end = course.endsAt
    ? new Date(course.endsAt)
    : new Date(start.getTime() + (Number(course.duration) || 0) * 60 * 1000);
  if (now < start) return "Upcoming";
  if (now < end) return "Live now";
  return "Ended";
}

export function getRefundInfo(course) {
  const snapshot = course.refundPolicySnapshot || course.refundPolicy || course.refundPolicyPreview;
  const onlineVideo = course.onlineVideo || course.progressTrackingType === "online_video";
  const total = Number(course.totalDurationSeconds ?? course.duration ?? 0);
  const watched = Number(course.watchedSeconds ?? course.watched ?? 0);
  const ratio = onlineVideo && total > 0 ? watched / total : null;
  const progress = ratio === null ? null : Math.round(ratio * 100);
  const progressConditionMet = ratio === null ? null : ratio <= WATCH_REFUND_LIMIT;
  const serverEligible = course.refundEligibility?.eligible ?? course.refundEligible;
  const delivery = getDeliveryModes(course);
  const deliveryDetail = delivery.includes("cloud")
    ? "Cloud is a protected course-file download."
    : delivery.includes("live") || delivery.includes("local")
      ? "The Trainer and learner coordinate fulfilment using buyer-only information."
      : "Delivery is recorded in the purchase snapshot.";
  return {
    eligible: Boolean(course.purchased && serverEligible === true),
    policyPreview: !course.purchased,
    progress,
    progressConditionMet,
    summary: snapshot?.summary || (onlineVideo
      ? `Online-video viewing condition: ${WATCH_REFUND_LIMIT * 100}% watched or less`
      : "Server-recorded purchase policy"),
    detail: `${deliveryDetail} ${onlineVideo
      ? `The API records watchedSeconds / totalDurationSeconds; the progress condition is met at ${WATCH_REFUND_LIMIT * 100}% or less.`
      : "Delivery mode does not create a viewing-progress rule."} Final eligibility comes from the server-side purchase snapshot.`,
  };
}
