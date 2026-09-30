import { ApiError } from '../lib/http.js';

export function videoAvailability(startsAt: Date | null, serverTime: Date): 'ready' | 'scheduled' | 'schedule_required' {
  if (!startsAt || !Number.isFinite(startsAt.getTime())) return 'schedule_required';
  return startsAt > serverTime ? 'scheduled' : 'ready';
}

export function assertVideoStarted(startsAt: Date | null, serverTime: Date) {
  const state = videoAvailability(startsAt, serverTime);
  if (state === 'schedule_required') throw new ApiError(409, 'COURSE_START_REQUIRED', 'The Trainer must set a start time before this video can be watched.');
  if (state === 'scheduled') throw new ApiError(403, 'COURSE_NOT_STARTED', 'This video course has not started yet.', { startsAt: startsAt!.toISOString() });
}
