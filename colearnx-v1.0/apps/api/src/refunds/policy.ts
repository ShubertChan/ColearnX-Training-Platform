export type RefundInput = {
  deliveryModes: string[];
  purchasedAt: Date;
  requestTime: Date;
  progressPercent?: number;
  startsAt?: Date | null;
};

export type RefundDecision = { eligible: boolean; code: string; explanation: string };
const hours = (value: number) => value * 60 * 60 * 1000;

export function evaluateRefund(input: RefundInput): RefundDecision {
  const modes = new Set(input.deliveryModes);
  if (modes.has('local')) return { eligible: false, code: 'LOCAL_NON_REFUNDABLE', explanation: 'Local delivery is non-refundable in V1.' };
  if (modes.has('live')) {
    if (!input.startsAt) return { eligible: false, code: 'LIVE_START_UNKNOWN', explanation: 'The Live course has no confirmed start time.' };
    const deadline = input.startsAt.getTime() - hours(72);
    return input.requestTime.getTime() <= deadline
      ? { eligible: true, code: 'LIVE_WITHIN_WINDOW', explanation: 'The request is at least 72 hours before the Live course starts.' }
      : { eligible: false, code: 'LIVE_WINDOW_EXPIRED', explanation: 'Live refunds close 72 hours before the scheduled start.' };
  }
  if (modes.has('cloud') || modes.has('record')) {
    const withinWindow = input.requestTime.getTime() <= input.purchasedAt.getTime() + hours(72);
    const progress = input.progressPercent ?? 0;
    if (withinWindow && progress <= 10) return { eligible: true, code: 'HOSTED_WITHIN_WINDOW', explanation: 'The request is within 72 hours and viewing progress is at most 10%.' };
    return { eligible: false, code: withinWindow ? 'HOSTED_PROGRESS_EXCEEDED' : 'HOSTED_WINDOW_EXPIRED', explanation: withinWindow ? 'Hosted-course viewing progress is above 10%.' : 'Hosted-course refunds close 72 hours after purchase.' };
  }
  return { eligible: false, code: 'DELIVERY_POLICY_UNAVAILABLE', explanation: 'This product has no approved refund policy.' };
}
