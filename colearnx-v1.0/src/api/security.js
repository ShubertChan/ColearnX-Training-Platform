import { apiClient } from "./client.js";
import { withStepUp } from "./stepUp.js";

const unwrap = (response) => response.data.data;

// The audit endpoints the dashboard reads are step-up gated, exactly like the
// high-risk admin mutations (previewContentSubmission). Those mutations flow
// through mutateApi({ stepUp: true }); a GET does not, so this is the read-side
// equivalent: wrap the request in withStepUp, which opens the identity modal
// once, caches the short-lived proof, retries a single time if the server
// reports the proof expired, and attaches it as the X-Step-Up-Token header.
export async function getWithStepUp(path, config = {}) {
  return withStepUp((stepUpToken) => apiClient.get(path, {
    ...config,
    headers: { ...(config.headers || {}), "X-Step-Up-Token": stepUpToken },
  }));
}

function toQuery(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    query.set(key, String(value));
  });
  const string = query.toString();
  return string ? `?${string}` : "";
}

export const getSecuritySummary = ({ from, to } = {}) =>
  getWithStepUp(`/admin/security/summary${toQuery({ from, to })}`).then(unwrap);

export const getSecurityEvents = ({ from, to, type, minSeverity, limit, cursor } = {}) =>
  getWithStepUp(`/admin/security/events${toQuery({ from, to, type, minSeverity, limit, cursor })}`).then((response) => ({
    events: response.data.data,
    hasNext: Boolean(response.data.meta?.hasNext),
    nextCursor: response.data.meta?.nextCursor || null,
  }));
