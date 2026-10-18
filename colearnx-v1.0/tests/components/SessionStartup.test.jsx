import React, { StrictMode } from "react";
import axios from "axios";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { apiClient, hasAccessToken, setAccessToken, setCsrfToken } from "../../src/api/client";
import { PlatformProvider, usePlatform } from "../../src/context/PlatformContext";

let platform;
const originalAdapter = apiClient.defaults.adapter;
const user = { id: "confirmed-member", email: "member@example.test", roles: ["member"] };
const response = (config, data) => ({ config, status: 200, headers: {}, data: { data } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function Probe() {
  platform = usePlatform();
  return <><output data-testid="loading">{String(platform.accountLoading)}</output><output data-testid="identity">{platform.profile.id || "anonymous"}</output><output data-testid="error">{platform.accountError}</output></>;
}
function fixture(config) {
  if (config.url === "/auth/csrf") return response(config, { csrfToken: null });
  if (config.url === "/me") return response(config, user);
  if (config.url === "/wallet") return response(config, { availablePoints: 0 });
  return response(config, []);
}
const mount = () => render(<StrictMode><PlatformProvider><Probe /></PlatformProvider></StrictMode>);
const settled = () => waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
beforeEach(() => { setAccessToken(""); setCsrfToken(""); apiClient.defaults.adapter = async config => fixture(config); });
afterEach(() => { apiClient.defaults.adapter = originalAdapter; setAccessToken(""); setCsrfToken(""); });

test("StrictMode and concurrent retry clicks share one bootstrap and one cookie rotation", async () => {
  const gate = deferred(); let reads = 0, posts = 0;
  apiClient.defaults.adapter = async config => {
    if (config.url === "/auth/csrf") { reads++; await gate.promise; return response(config, { csrfToken: "csrf" }); }
    if (config.url === "/auth/refresh") { posts++; return response(config, { accessToken: "fresh", csrfToken: "csrf", user }); }
    return fixture(config);
  };
  mount();
  let first, second;
  act(() => { first = platform.retrySession(); second = platform.retrySession(); });
  expect(first).toBe(second); expect(platform.authenticated).toBe(false);
  await act(async () => { gate.resolve(); await first; });
  await settled();
  expect(reads).toBe(1); expect(posts).toBe(1); expect(platform.profile.id).toBe(user.id);
});

test("a temporary GET failure recovers automatically without clearing the stored bearer", async () => {
  vi.useFakeTimers(); setAccessToken("stored"); let reads = 0;
  apiClient.defaults.adapter = async config => {
    if (config.url === "/me" && ++reads === 1) throw new axios.AxiosError("Timed out", "ECONNABORTED", config);
    return fixture(config);
  };
  mount(); await act(async () => {});
  expect(hasAccessToken()).toBe(true); expect(platform.authenticated).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(reads).toBe(2); expect(platform.authenticated).toBe(true); expect(platform.accountError).toBe("");
});

test("a minute-long cold start recovers automatically instead of stopping at the old 12-second timeout", async () => {
  vi.useFakeTimers(); let reads = 0;
  apiClient.defaults.adapter = async config => {
    if (config.url === "/auth/csrf") {
      const attempt = ++reads;
      await new Promise(resolve => setTimeout(resolve, attempt < 3 ? config.timeout : 17000));
      if (attempt < 3) throw new axios.AxiosError("Timed out", "ECONNABORTED", config);
    }
    return fixture(config);
  };
  mount(); await act(async () => vi.advanceTimersByTimeAsync(12000));
  expect(platform.accountLoading).toBe(true); expect(platform.accountError).toBe("");
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(platform.accountLoading).toBe(true); expect(platform.accountError).toBe("");
  await act(async () => vi.advanceTimersByTimeAsync(18000));
  expect(reads).toBe(3); expect(platform.accountLoading).toBe(false);
  expect(platform.accountError).toBe(""); expect(platform.authenticated).toBe(false);
});

test("permanent GET failure stops, preserves credentials and supports a later in-page retry", async () => {
  vi.useFakeTimers(); setAccessToken("stored"); let reads = 0, unavailable = true;
  apiClient.defaults.adapter = async config => {
    if (config.url === "/me") {
      reads++;
      if (unavailable) throw new axios.AxiosError("Unavailable", "ERR_BAD_RESPONSE", config, null, { status: 503, data: {} });
    }
    return fixture(config);
  };
  mount(); await act(async () => vi.advanceTimersByTimeAsync(7000));
  expect(reads).toBe(4); expect(platform.accountLoading).toBe(false);
  expect(platform.authenticated).toBe(false); expect(platform.accountError).not.toBe(""); expect(hasAccessToken()).toBe(true);
  unavailable = false;
  await act(async () => platform.retrySession());
  expect(platform.authenticated).toBe(true); expect(platform.accountError).toBe("");
});

test("a warm-up HTML response is retried, not mistaken for an anonymous session", async () => {
  vi.useFakeTimers(); let reads = 0, posts = 0;
  apiClient.defaults.adapter = async config => {
    if (config.url === "/auth/csrf" && ++reads === 1) return { ...response(config, null), data: "<html>Starting service</html>" };
    if (config.url === "/auth/refresh") posts++;
    return fixture(config);
  };
  mount(); await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(reads).toBe(2); expect(posts).toBe(0); expect(platform.accountLoading).toBe(false); expect(platform.accountError).toBe("");
});

test("an empty CSRF response is retried without logging the user out or sending a refresh POST", async () => {
  vi.useFakeTimers(); let reads = 0, posts = 0;
  apiClient.defaults.adapter = async config => {
    if (config.url === "/auth/csrf" && ++reads === 1) return response(config, { csrfToken: "" });
    if (config.url === "/auth/refresh") posts++;
    return fixture(config);
  };
  mount(); await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(reads).toBe(2); expect(posts).toBe(0); expect(platform.accountLoading).toBe(false); expect(platform.accountError).toBe("");
});

test("sign-in waits for rotation and an older recovery cannot overwrite the new identity", async () => {
  const gate = deferred(); let logins = 0;
  apiClient.defaults.adapter = async config => {
    if (config.url === "/auth/csrf") { await gate.promise; return response(config, { csrfToken: "csrf" }); }
    if (config.url === "/auth/refresh") return response(config, { accessToken: "old", csrfToken: "csrf", user: { ...user, id: "old-account" } });
    if (config.url === "/auth/login") { logins++; return response(config, { accessToken: "new", csrfToken: "new-csrf" }); }
    return fixture(config);
  };
  mount(); let login;
  act(() => { login = platform.signIn({ email: "member@example.test", password: "test only" }); });
  expect(logins).toBe(0);
  await act(async () => { gate.resolve(); await login; });
  expect(logins).toBe(1); expect(platform.profile.id).toBe(user.id);
  expect(platform.accountLoading).toBe(false); expect(platform.accountError).toBe("");
});

test("sign-out during bootstrap never resurrects the old identity", async () => {
  const gate = deferred();
  apiClient.defaults.adapter = async config => {
    if (config.url === "/auth/csrf") { await gate.promise; return response(config, { csrfToken: "csrf" }); }
    if (config.url === "/auth/refresh") return response(config, { accessToken: "old", csrfToken: "csrf", user });
    return fixture(config);
  };
  mount(); let logout;
  act(() => { logout = platform.signOut(); });
  await act(async () => { gate.resolve(); await logout; });
  expect(platform.authenticated).toBe(false); expect(hasAccessToken()).toBe(false);
  expect(platform.profile.id).not.toBe(user.id); expect(platform.accountLoading).toBe(false);
});
