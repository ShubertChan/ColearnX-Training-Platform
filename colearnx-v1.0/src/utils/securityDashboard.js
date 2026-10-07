// Pure helpers for the admin security monitor. Kept out of the page component
// so the labelling, the severity-to-tone mapping and the trend geometry can be
// unit-tested without a DOM.

// 0 info, 1 low, 2 medium, 3 high, 4 critical (security/taxonomy.ts). Tones map
// onto the Badge tones the design system already ships (neutral/warning/danger);
// the label, not the colour alone, carries the high-vs-critical distinction.
export const SEVERITY_META = {
  0: { label: "Info", tone: "neutral" },
  1: { label: "Low", tone: "neutral" },
  2: { label: "Medium", tone: "warning" },
  3: { label: "High", tone: "danger" },
  4: { label: "Critical", tone: "danger" },
};

export const SEVERE_THRESHOLD = 3;

export function severityMeta(severity) {
  return SEVERITY_META[severity] ?? { label: `Level ${severity}`, tone: "neutral" };
}

export const severityLabel = (severity) => severityMeta(severity).label;
export const severityTone = (severity) => severityMeta(severity).tone;

/**
 * "auth.login_failed" -> "Auth · Login failed". The taxonomy is a dotted
 * category.name string; this makes it readable without a lookup table that
 * would drift from the server's vocabulary.
 */
export function formatEventType(type) {
  const [group, ...rest] = String(type || "").split(".");
  const name = rest.join(".").replace(/_/g, " ");
  const sentence = name ? name.charAt(0).toUpperCase() + name.slice(1) : "";
  const label = group ? group.charAt(0).toUpperCase() + group.slice(1) : "";
  return sentence ? `${label} · ${sentence}` : label || String(type || "");
}

/**
 * Trend geometry for the daily bar chart. Returns, per day, the total and
 * severe counts plus their heights as a percentage of the busiest day, so the
 * SVG/CSS renderer stays declarative. An all-zero window yields flat zero
 * bars rather than dividing by zero.
 */
export function buildTrend(daily = []) {
  const peak = daily.reduce((max, day) => Math.max(max, Number(day.total) || 0), 0);
  const scale = peak > 0 ? peak : 1;
  const bars = daily.map((day) => {
    const total = Number(day.total) || 0;
    const severe = Math.min(Number(day.severe) || 0, total);
    return {
      date: day.date,
      total,
      severe,
      routine: total - severe,
      totalPct: Math.round((total / scale) * 100),
      severePct: Math.round((severe / scale) * 100),
    };
  });
  return { peak, bars };
}

export function totalFromSeverity(severityTotals = {}) {
  return Object.values(severityTotals).reduce((sum, value) => sum + (Number(value) || 0), 0);
}
