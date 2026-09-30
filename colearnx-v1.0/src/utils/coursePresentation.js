const normaliseModes = (value) =>
  (Array.isArray(value) ? value : []).map((mode) => String(mode).toLowerCase());

export function isVideoCourse(course = {}) {
  return Boolean(course.onlineVideo || course.progressTrackingType === "online_video" || course.courseVideoVersionId);
}

export function getCourseTypeLabel(course = {}) {
  if (isVideoCourse(course)) return "Video course";
  const modes = normaliseModes(course.deliveryModes);
  if (modes.includes("live") && modes.includes("local")) return "Instructor-led course · Online live + Offline arrangement";
  if (modes.includes("live")) return "Instructor-led course · Online live";
  if (modes.includes("local")) return "Instructor-led course · Offline arrangement";
  if (modes.includes("cloud")) return "Course files";
  return "Course";
}
