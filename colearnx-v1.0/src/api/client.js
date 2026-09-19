import axios from "axios";
import { readSessionValue, writeSessionValue } from "../utils/sessionStorage.js";

const accessTokenKey = "colearnx-api-access-token";
const csrfTokenKey = "colearnx-api-csrf-token";
let accessToken = readSessionValue(accessTokenKey);
let csrfToken = readSessionValue(csrfTokenKey);
let sessionGeneration = 0, refreshInFlight = null;
const pendingMutations = new Map();

export const apiClient = axios.create({ baseURL: import.meta.env?.VITE_API_BASE_URL || "/api/v1", timeout: 12000, withCredentials: true, headers: { Accept: "application/json", "Content-Type": "application/json" } });

export function setAccessToken(token) { sessionGeneration++; pendingMutations.clear(); accessToken = token || ""; writeSessionValue(accessTokenKey, accessToken); }
export const hasAccessToken = () => Boolean(accessToken);
export function setCsrfToken(token) { csrfToken = token || ""; writeSessionValue(csrfTokenKey, csrfToken); }
export const hasCsrfToken = () => Boolean(csrfToken);

apiClient.interceptors.request.use((config) => {
  config._sessionGeneration ??= sessionGeneration;
  if (config._sessionGeneration !== sessionGeneration) throw sessionChanged();
  config._sentAccessToken = config._skipAccessToken ? "" : accessToken;
  if (config._sentAccessToken) config.headers.Authorization = `Bearer ${config._sentAccessToken}`;
  else config.headers.delete("Authorization");
  if (csrfToken && !["get", "head", "options"].includes(String(config.method || "get").toLowerCase())) config.headers["X-CSRF-Token"] = csrfToken;
  else config.headers.delete("X-CSRF-Token");
  if (!["get", "head", "options"].includes(String(config.method || "get").toLowerCase()) && !config.headers.has("Idempotency-Key")) config.headers.set("Idempotency-Key", crypto.randomUUID());
  return config;
});

const sessionChanged = () => Object.assign(new Error("Your account session changed. Please try again."), { code: "SESSION_CHANGED", status: 401 });

async function refreshAccess(generation) {
  if (refreshInFlight?.generation === generation) return refreshInFlight.promise;
  const refresh = { generation };
  refresh.promise = (async () => {
    try {
      const options = { _skipAuthRefresh: true, _skipAccessToken: true, _sessionGeneration: generation };
      const csrf = (await apiClient.get("/auth/csrf", options)).data.data;
      if (generation !== sessionGeneration) throw sessionChanged();
      if (!csrf?.csrfToken) throw Object.assign(new Error("Please sign in again."), { code: "AUTH_SESSION_EXPIRED", status: 401 });
      setCsrfToken(csrf.csrfToken);
      const result = (await apiClient.post("/auth/refresh", {}, options)).data.data;
      if (generation !== sessionGeneration) throw sessionChanged();
      if (!result?.accessToken || !result.csrfToken) throw Object.assign(new Error("The session service returned an incomplete response."), { code: "AUTH_REFRESH_INVALID", status: 502 });
      // Rotation keeps the same account generation; explicit sign-in/out invalidates queued work.
      accessToken = result.accessToken; writeSessionValue(accessTokenKey, accessToken);
      setCsrfToken(result.csrfToken);
    } catch (error) {
      if (generation === sessionGeneration && [401, 403].includes(error.status)) { setAccessToken(""); setCsrfToken(""); }
      throw error;
    } finally { if (refreshInFlight === refresh) refreshInFlight = null; }
  })();
  refreshInFlight = refresh;
  return refresh.promise;
}

apiClient.interceptors.response.use((response) => response, async (error) => {
  const config = error.config, code = error.response?.data?.error?.code;
  if (config && error.response?.status === 401 && !config._authRetried && !config._skipAuthRefresh
    && !/(^|\/)auth\//.test(config.url || "") && !String(code || "").startsWith("PLAYBACK_") && config._sentAccessToken) {
    if (config._sessionGeneration !== sessionGeneration) throw sessionChanged();
    config._authRetried = true;
    if (config._sentAccessToken === accessToken) await refreshAccess(config._sessionGeneration);
    if (config._sessionGeneration !== sessionGeneration) throw sessionChanged();
    // Axios preserves the payload, abort signal and original Idempotency-Key.
    return apiClient.request(config);
  }
  if (!error.response && error.code && error.status) throw error;
  const apiError = new Error(error.response?.data?.error?.message || "The service is temporarily unavailable. Please try again.");
  apiError.code = code || (error.code === "ERR_CANCELED" ? error.code : "NETWORK_ERROR");
  apiError.status = error.response?.status || 0;
  apiError.requestId = error.response?.data?.error?.requestId || "";
  return Promise.reject(apiError);
});

// Retain uncertain operations in memory so a manual retry also uses the same key.
// Successful operations and explicit account changes release their keys.
export async function mutateApi(method, url, data) {
  const identity = JSON.stringify([sessionGeneration, method, url, data ?? null]);
  const key = pendingMutations.get(identity) || crypto.randomUUID();
  pendingMutations.set(identity, key);
  const options = { headers: { "Idempotency-Key": key } };
  try {
    const response = method === "delete" ? await apiClient.delete(url, { ...options, data }) : await apiClient[method](url, data, options);
    if (pendingMutations.get(identity) === key) pendingMutations.delete(identity);
    return response;
  } catch (error) {
    const readinessRejected = error.status === 409 && ["VIDEO_NOT_READY", "CONTENT_FILE_NOT_READY"].includes(error.code);
    if (([400, 403, 404, 405, 422].includes(error.status) || readinessRejected) && pendingMutations.get(identity) === key) pendingMutations.delete(identity);
    throw error;
  }
}
