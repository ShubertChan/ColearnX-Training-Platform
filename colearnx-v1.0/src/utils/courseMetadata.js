const normalizedStatus = (value) => String(value || '').toLowerCase();

export const canEditCourseMetadata = (item) => item?.kind === 'course'
  && normalizedStatus(item.status) === 'draft'
  && normalizedStatus(item.publicationStatus) === 'draft';

// PATCH /courses/:id currently accepts a full course schema. Preserve the
// unedited server fields rather than silently clearing them with form defaults.
export function buildCourseMetadataUpdate(item, form, reason) {
  if (!canEditCourseMetadata(item)) throw new Error('Only an owned draft course can have its metadata updated.');
  const retained = ['categoryId', 'capacity', 'startsAt', 'endsAt', 'timezone', 'progressTrackingType', 'totalDurationSeconds'];
  if (retained.some((field) => item[field] === undefined)
    || !Array.isArray(item.deliveryModes) || !item.deliveryModes.length) {
    throw new Error('The course details are incomplete. Refresh My listings before editing.');
  }
  if (!['none', 'online_video'].includes(item.progressTrackingType)
    || (item.progressTrackingType === 'online_video' && !(Number(item.totalDurationSeconds) > 0))) {
    throw new Error('The saved video configuration is incomplete. Refresh My listings before editing.');
  }
  const title = String(form.title || '').trim();
  const pricePoints = Number(form.pricePoints);
  if (!title || String(form.pricePoints ?? '').trim() === '' || !Number.isSafeInteger(pricePoints) || pricePoints < 0) {
    throw new Error('Enter a title and a non-negative whole-number points price.');
  }
  const coordination = item.deliveryModes.some((mode) => mode === 'local' || mode === 'live');
  const instructions = String(form.fulfilmentInstructions || '').trim();
  const contact = String(form.trainerContact || '').trim();
  if (coordination && (!instructions || !contact)) throw new Error('Enter buyer-only instructions and Trainer contact details.');
  let joinUrl = null;
  if (coordination && String(form.joinUrl || '').trim()) {
    try {
      const url = new URL(String(form.joinUrl).trim());
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      joinUrl = url.href;
    } catch { throw new Error('Use an HTTP or HTTPS meeting or group URL.'); }
  }
  return {
    title,
    description: String(form.description || '').trim(),
    pricePoints,
    ...(item.categoryId === null ? {} : { categoryId: item.categoryId }),
    capacity: item.capacity,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    ...(item.timezone === null ? {} : { timezone: item.timezone }),
    deliveryModes: [...item.deliveryModes],
    progressTrackingType: item.progressTrackingType,
    totalDurationSeconds: item.totalDurationSeconds,
    fulfilmentInstructions: coordination ? instructions : null,
    trainerContact: coordination ? contact : null,
    joinUrl,
    changeSummary: String(reason || '').trim(),
  };
}
