export function intendedPath(location, fallback = "/home") {
  if (!location?.pathname?.startsWith("/") || location.pathname.startsWith("//")) return fallback;
  return `${location.pathname}${location.search || ""}${location.hash || ""}`;
}

export function cartStorageKey(accountId) {
  return accountId ? `colearnx-cart-v3:${encodeURIComponent(accountId)}` : null;
}

export function readAccountCart(storage, accountId) {
  const key = cartStorageKey(accountId);
  if (!key) return [];
  try {
    const value = JSON.parse(storage.getItem(key) || "[]");
    const seen = new Set();
    return (Array.isArray(value) ? value : []).filter((item) => {
      if (!["course", "content"].includes(item?.kind) || typeof item.id !== "string" || !item.id) return false;
      const identity = `${item.kind}:${item.id}`;
      if (seen.has(identity)) return false;
      seen.add(identity); return true;
    });
  } catch { return []; }
}

export function mergeConfirmedOrders(serverOrders, confirmedOrders) {
  const ids = new Set(serverOrders.map((order) => order.id));
  return [...confirmedOrders.filter((order) => !ids.has(order.id)), ...serverOrders];
}

// Only count forward playback observed in real time. Seeking never adds time.
// Intervals are merged so replaying a section cannot inflate unique watched time.
export function addWatchedInterval(intervals, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return intervals;
  const merged = [];
  for (const interval of [...intervals, [start, end]].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
}

export function samplePlayback(previous, sample, intervals) {
  if (!previous || sample.seeking || previous.seeking || sample.paused || previous.paused) return intervals;
  const wallSeconds = Math.max(0, (sample.now - previous.now) / 1000);
  const mediaSeconds = sample.position - previous.position;
  if (wallSeconds > 3 || mediaSeconds <= 0 || mediaSeconds > wallSeconds * Math.max(1, sample.rate || 1) + 0.35) return intervals;
  return addWatchedInterval(intervals, previous.position, sample.position);
}

export const watchedDuration = (intervals) => intervals.reduce((sum, [start, end]) => sum + end - start, 0);
