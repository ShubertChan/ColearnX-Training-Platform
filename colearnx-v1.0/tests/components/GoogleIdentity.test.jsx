import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../src/api/client', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));

const sdkSelector = 'script[src="https://accounts.google.com/gsi/client"]';

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  delete window.google;
});

afterEach(() => {
  document.querySelectorAll(sdkSelector).forEach(script => script.remove());
  delete window.google;
  vi.clearAllTimers();
  vi.useRealTimers();
});

test('SDK loading shares one origin-only request and reuses the loaded identity', async () => {
  const { loadGoogleIdentity } = await import('../../src/api/googleIdentity');
  const first = loadGoogleIdentity();
  expect(loadGoogleIdentity()).toBe(first);
  expect(document.querySelectorAll(sdkSelector)).toHaveLength(1);
  const script = document.querySelector(sdkSelector);
  expect(script.referrerPolicy).toBe('strict-origin');
  // jsdom does not reflect this script property to an HTML attribute; the
  // browser regression checks the real DOM attribute in Chromium instead.
  expect(script.async).toBe(true);

  const identity = { initialize: vi.fn(), renderButton: vi.fn() };
  window.google = { accounts: { id: identity } };
  script.onload(new Event('load'));
  await expect(first).resolves.toBe(identity);
  await expect(loadGoogleIdentity()).resolves.toBe(identity);
});

test('a failed SDK request can retry without losing the origin-only policy', async () => {
  const { loadGoogleIdentity } = await import('../../src/api/googleIdentity');
  const first = loadGoogleIdentity();
  const failed = expect(first).rejects.toThrow('Google sign-in could not load');
  document.querySelector(sdkSelector).onerror(new Event('error'));
  await failed;
  expect(document.querySelector(sdkSelector)).toBeNull();

  const retry = loadGoogleIdentity();
  const script = document.querySelector(sdkSelector);
  expect(script.referrerPolicy).toBe('strict-origin');
  const identity = { initialize: vi.fn(), renderButton: vi.fn() };
  window.google = { accounts: { id: identity } };
  script.onload(new Event('load'));
  await expect(retry).resolves.toBe(identity);
});
