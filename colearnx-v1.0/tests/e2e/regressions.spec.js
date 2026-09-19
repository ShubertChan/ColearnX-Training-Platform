// Regression coverage for the four findings from the 2026-09-18 frontend review.
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { mockVideoApi } from './video.fixture.js';
import { TrainerVideoPage, LearnerVideoPage } from './video.pages.js';

test('course submission retries an uncertain response with its original idempotency key', async ({ page }) => {
  const state = await mockVideoApi(page); state.status = 'ready';
  const keys = [];
  await page.route('**/api/v1/courses/course/submit', async route => {
    keys.push(route.request().headers()['idempotency-key']);
    if (keys.length === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Retry this submission' } }) });
    else await route.fallback();
  });
  const trainer = new TrainerVideoPage(page); await trainer.open('course');
  await expect(trainer.submitButton()).toBeEnabled();
  await trainer.submitButton().click();
  await expect(page.getByText('Retry this submission', { exact: true })).toBeVisible();
  await trainer.submitButton().click();
  await expect.poll(() => state.submitted).toBe(true);
  expect(keys).toHaveLength(2); expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]);
});

test('publishing tools block unavailable attachments and recover after refreshing them', async ({ page }) => {
  const state = await mockVideoApi(page); state.status = 'ready'; state.attachmentError = true;
  await page.goto('/#/publishing-tools');
  await page.getByRole('combobox', { name: 'Choose a listing', exact: true }).selectOption('course');
  const submit = page.getByRole('button', { name: 'Submit video version for review', exact: true });
  await expect(page.getByText('Course attachments could not be checked. Refresh attachments before submitting.')).toBeVisible();
  await expect(submit).toBeDisabled();
  expect(state.submitted).toBe(false);
  state.attachmentError = false;
  await page.getByRole('button', { name: 'Refresh attachments', exact: true }).click();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect.poll(() => state.submitted).toBe(true);
  expect(state.calls.filter(c => c.path === '/courses/course/assets').length).toBeGreaterThanOrEqual(3);
});

test('expired account token refreshes and retries the same heartbeat without resetting playback', async ({ page }) => {
  const state = await mockVideoApi(page, 'member'); state.playback = true; state.duration = 14;
  await page.route('**/fixture-media/**', async route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1);
    await route.fulfill({ status: 200, contentType: name.endsWith('m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4', body: await readFile(new URL(`../fixtures/hls/${name}`, import.meta.url)) });
  });
  await new LearnerVideoPage(page).open();
  const sync = page.getByRole('button', { name: 'Sync viewing progress' });
  await expect(sync).toBeVisible();
  const video = page.getByLabel('Course video', { exact: true });
  await video.evaluate(media => { media.currentTime = 5; });
  const requests = []; let refreshes = 0;
  await page.route('**/api/v1/auth/refresh', async route => {
    refreshes++;
    expect(route.request().headers()['x-csrf-token']).toBe('test-csrf');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { accessToken: 'refreshed-session', csrfToken: 'refreshed-csrf' } }) });
  });
  await page.route('**/api/v1/order-items/order-item/**', async route => {
    if (!route.request().url().endsWith('/progress')) return route.fallback();
    const request = route.request();
    requests.push({ token: request.headers().authorization, body: request.postDataJSON(), key: request.headers()['idempotency-key'] });
    if (request.headers().authorization === 'Bearer refreshed-session') await route.fallback();
    else await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ACCESS_TOKEN_EXPIRED', message: 'The account access token expired' } }) });
  });
  await sync.click();
  await expect.poll(() => requests.some(r => r.token === 'Bearer refreshed-session')).toBe(true);
  await expect(sync).toBeVisible();
  await expect(page.getByText('This video is unavailable for this account or purchase.')).toHaveCount(0);
  expect(refreshes).toBe(1); expect(state.sessions).toBe(1);
  expect(await video.evaluate(media => media.currentTime)).toBeGreaterThanOrEqual(5);
  const first = requests.find(r => r.token === 'Bearer test-session');
  const retried = requests.find(r => r.token === 'Bearer refreshed-session' && r.body.sequence === first.body.sequence);
  expect(retried.body).toEqual(first.body); expect(retried.key).toBe(first.key);
});

test('blocked session storage still allows cookie-based session recovery and course browsing', async ({ page }) => {
  await mockVideoApi(page, 'member');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new DOMException('Review: browser storage blocked', 'SecurityError'); } }));
  await page.goto('/#/courses');
  await expect(page.getByText('Browser session storage is unavailable.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(page.getByText('Recorded design workshop', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('publishing tools recheck attachment readiness immediately before submitting', async ({ page }) => {
  const state = await mockVideoApi(page); state.status = 'ready';
  await page.goto('/#/publishing-tools');
  await page.getByRole('combobox', { name: 'Choose a listing', exact: true }).selectOption('course');
  const submit = page.getByRole('button', { name: 'Submit video version for review', exact: true });
  await expect(submit).toBeEnabled();
  await page.route('**/api/v1/courses/course/assets', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { assets: [{ assetId: 'pending-notes', status: 'upload_pending', purpose: 'attachment' }] } }) }));
  await submit.click();
  await expect(page.getByText('Course attachments are not ready.', { exact: false })).toBeVisible();
  await expect(submit).toBeDisabled();
  expect(state.submitted).toBe(false);
});
