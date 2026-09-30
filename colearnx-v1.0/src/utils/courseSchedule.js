export function localDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
}

export function courseUpdatePayload(item, form, changeSummary) {
  const dateValue = (value, previous) => value === localDateTime(previous) ? previous || null : value ? new Date(value).toISOString() : null;
  const startsAt = dateValue(form.startsAt, item.startsAt), endsAt = dateValue(form.endsAt, item.endsAt);
  const video = Boolean(item.onlineVideo || item.progressTrackingType === "online_video");
  const coordination = item.deliveryModes.some(mode => mode === "local" || mode === "live");
  if ((video || coordination) && !startsAt) throw new Error("Set a start time before saving this course.");
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) throw new Error("End time must be after start time.");
  return {
    title: form.title.trim(), description: form.description.trim(), pricePoints: Number(form.pricePoints),
    categoryId: item.categoryId || undefined, capacity: item.capacity ?? null,
    startsAt, endsAt, timezone: item.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    deliveryModes: [...item.deliveryModes], progressTrackingType: video ? "online_video" : "none",
    fulfilmentInstructions: coordination ? form.fulfilmentInstructions.trim() : null,
    trainerContact: coordination ? form.trainerContact.trim() : null,
    joinUrl: item.deliveryModes.includes("live") ? form.joinUrl.trim() || null : null,
    changeSummary: changeSummary.trim(),
  };
}
