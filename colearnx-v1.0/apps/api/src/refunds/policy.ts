export type RefundInput = {
  policySnapshot?: unknown;
  requestTime: Date;
  watchedSeconds?: number;
  totalDurationSeconds?: number | null;
  downloadCompletedAt?: Date | null;
  deliveryModes?: string[];
  purchasedAt?: Date;
  progressPercent?: number;
  startsAt?: Date | null;
};

export type RefundDecision = { eligible: boolean; code: string; explanation: string };
const hours = (value: number) => value * 60 * 60 * 1000;

function snapshot(value: unknown) {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function evaluateRefund(input: RefundInput): RefundDecision {
  const policy = snapshot(input.policySnapshot);
  if (policy.rule === 'self-arranged-72h-v1') {
    const startsAt = typeof policy.startsAt === 'string' ? new Date(policy.startsAt) : null;
    if (!startsAt || Number.isNaN(startsAt.getTime())) return { eligible: false, code: 'SELF_ARRANGED_START_UNKNOWN', explanation: 'A self-arranged course needs a confirmed start time for refund assessment.' };
    const deadline = startsAt.getTime() - hours(72);
    return input.requestTime.getTime() <= deadline
      ? { eligible: true, code: 'SELF_ARRANGED_WITHIN_NOTICE', explanation: 'The request was made at least 72 hours before the self-arranged course starts.' }
      : { eligible: false, code: 'SELF_ARRANGED_NOTICE_EXPIRED', explanation: 'Self-arranged course refunds close 72 hours before the course starts.' };
  }
  if (policy.rule === 'recorded-media-10pct-no-download-v1') {
    const watchedSeconds = Math.max(0, Number(input.watchedSeconds ?? 0));
    const totalDurationSeconds = Math.max(0, Number(input.totalDurationSeconds ?? policy.totalDurationSeconds ?? 0));
    const watchedRatio = totalDurationSeconds > 0 ? watchedSeconds / totalDurationSeconds : 0;
    const maximum = Number(policy.watchedRatioMaximum ?? 0.1);
    if (input.downloadCompletedAt) return { eligible: false, code: 'RECORDED_MEDIA_DOWNLOADED', explanation: 'Recorded video or file refunds require that no protected file was downloaded.' };
    if (watchedRatio > maximum) return { eligible: false, code: 'RECORDED_MEDIA_PROGRESS_EXCEEDED', explanation: 'Recorded-video viewing is above the 10% maximum.' };
    return { eligible: true, code: 'RECORDED_MEDIA_ELIGIBLE', explanation: 'Viewing is at or below 10% and no protected file download was recorded.' };
  }
  if (policy.rule === 'live-72h') {
    const startsAt = typeof policy.startsAt === 'string' ? new Date(policy.startsAt) : null;
    if (!startsAt || Number.isNaN(startsAt.getTime())) return { eligible: false, code: 'LIVE_START_UNKNOWN', explanation: 'The Live course has no confirmed start time.' };
    const deadline = startsAt.getTime() - hours(72);
    return input.requestTime.getTime() <= deadline
      ? { eligible: true, code: 'LIVE_WITHIN_WINDOW', explanation: 'The request is at least 72 hours before the Live course starts.' }
      : { eligible: false, code: 'LIVE_WINDOW_EXPIRED', explanation: 'Live refunds close 72 hours before the scheduled start.' };
  }
  if (policy.rule === 'local-v1' || policy.rule === 'content-policy-required') {
    return { eligible: false, code: 'LEGACY_POLICY_NON_REFUNDABLE', explanation: 'This historical order has a non-refundable policy snapshot.' };
  }
  if (policy.rule === 'hosted-72h-progress-10') {
    const purchasedAt = typeof policy.purchasedAt === 'string' ? new Date(policy.purchasedAt) : input.purchasedAt;
    if (!purchasedAt || Number.isNaN(purchasedAt.getTime())) return { eligible: false, code: 'LEGACY_PURCHASE_TIME_UNKNOWN', explanation: 'The historical refund window cannot be assessed without the purchase time.' };
    const maximumProgress = Number(policy.maxProgressPercent ?? 10);
    const watchedSeconds = Math.max(0, Number(input.watchedSeconds ?? 0));
    const totalDurationSeconds = Math.max(0, Number(input.totalDurationSeconds ?? 0));
    const progressPercent = input.progressPercent ?? (totalDurationSeconds > 0 ? watchedSeconds / totalDurationSeconds * 100 : 0);
    const withinWindow = input.requestTime.getTime() <= purchasedAt.getTime() + hours(Number(policy.refundWindowHours ?? 72));
    if (withinWindow && progressPercent <= maximumProgress) return { eligible: true, code: 'HOSTED_WITHIN_WINDOW', explanation: 'The request is within 72 hours and viewing progress is at most 10%.' };
    return { eligible: false, code: withinWindow ? 'HOSTED_PROGRESS_EXCEEDED' : 'HOSTED_WINDOW_EXPIRED', explanation: withinWindow ? 'Hosted-course viewing progress is above 10%.' : 'Hosted-course refunds close 72 hours after purchase.' };
  }
  return { eligible: false, code: 'DELIVERY_POLICY_UNAVAILABLE', explanation: 'This purchase has no recognised refund policy snapshot.' };
}
