import axios from "axios";

const accessTokenKey = "colearnx-api-access-token";
const csrfTokenKey = "colearnx-api-csrf-token";
let accessToken =
  typeof window === "undefined" ? "" : window.sessionStorage.getItem(accessTokenKey) || "";
let csrfToken =
  typeof window === "undefined" ? "" : window.sessionStorage.getItem(csrfTokenKey) || "";

export const apiClient = axios.create({
  baseURL: import.meta.env?.VITE_API_BASE_URL || "/api/v1",
  timeout: 12000,
  withCredentials: true,
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
  },
});

export function setAccessToken(token) {
  accessToken = token || "";
  if (typeof window === "undefined") return;
  if (accessToken) window.sessionStorage.setItem(accessTokenKey, accessToken);
  else window.sessionStorage.removeItem(accessTokenKey);
}

export const hasAccessToken = () => Boolean(accessToken);

export function setCsrfToken(token) {
  csrfToken = token || "";
  if (typeof window === "undefined") return;
  if (csrfToken) window.sessionStorage.setItem(csrfTokenKey, csrfToken);
  else window.sessionStorage.removeItem(csrfTokenKey);
}

export const hasCsrfToken = () => Boolean(csrfToken);

apiClient.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  if (csrfToken && !["get", "head", "options"].includes(String(config.method || "get").toLowerCase())) {
    config.headers["X-CSRF-Token"] = csrfToken;
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const message =
      error.response?.data?.error?.message ||
      "The service is temporarily unavailable. Please try again.";
    return Promise.reject(new Error(message));
  },
);
