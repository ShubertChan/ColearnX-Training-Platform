// Optional browser verification for the disposable database/API check.
// APIs are real. Only the external media boundary uses a local HLS sample.
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import { chromium, expect as baseExpect } from '@playwright/test';
import { build } from 'vite';

const expect = baseExpect.configure({ timeout: 20000 });

export async function checkVideoLearningBrowser({ app, root, origin, loginPassword, item, setStart, listings, delivery, pass }) {
  const appRoot = join(root, '../..'), output = join(appRoot, 'work/full-stack-video');
  Object.assign(process.env, { VITE_API_BASE_URL: '/api/v1', VITE_ENABLE_HOSTED_VIDEO: 'true', VITE_MEDIA_ORIGINS: origin, VITE_UPLOAD_ORIGINS: origin, VITE_PAYMENTS_API_ENABLED: 'false' });
  await build({ root: appRoot, configFile: join(appRoot, 'vite.config.js'), configLoader: 'native', build: { outDir: output } });
  const frontend = express();
  frontend.use((req, res, next) => req.path.startsWith('/api/') ? app(req, res, next) : next());
  // A fixture for the separate media gateway, not an API interception. Require
  // the actual API-issued HMAC token and the purchased video version binding.
  frontend.get('/v1/hls/:version/:file', async (req, res) => {
    try {
      const token = (req.get('authorization') || '').replace(/^Bearer /, '');
      const [format, payload, signature, extra] = token.split('.');
      const expected = Buffer.from(createHmac('sha256', process.env.VIDEO_PLAYBACK_TOKEN_SECRET).update(`${format}.${payload}`).digest('base64url'));
      const supplied = Buffer.from(signature || '');
      assert.ok(format === 'v1' && !extra && expected.length === supplied.length && timingSafeEqual(expected, supplied));
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      assert.ok(claims.scope === 'play' && claims.exp > Date.now() / 1000 && claims.videoVersionId === req.params.version);
      assert.ok(['master.m3u8', 'init.mp4', 'segment.m4s'].includes(req.params.file));
      res.type(req.params.file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4');
      res.send(await readFile(join(appRoot, 'tests/fixtures/hls', req.params.file)));
    } catch { res.status(403).end(); }
  });
  frontend.use(express.static(output));
  const server = createServer(frontend);
  let browser, externalRequests = 0;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(new URL(origin).port), '127.0.0.1', resolve); });
    browser = await chromium.launch({ headless: true, timeout: 20000 });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Singapore', reducedMotion: 'reduce' });
    context.setDefaultTimeout(20000);
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== origin) { externalRequests++; return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    const login = async email => {
      await page.goto(`${origin}/#/login`);
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      await page.getByLabel('Email address', { exact: true }).fill(email);
      await page.getByLabel('Password', { exact: true }).fill(loginPassword);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page).toHaveURL(/#\/home$/);
    };
    await login('trainer@example.test');
    await page.goto(`${origin}/#/trainer/course-editor`);
    const title = `Browser scheduled video ${randomUUID()}`;
    await page.getByLabel('Course title', { exact: true }).fill(title);
    await page.getByLabel('Public description', { exact: true }).fill('Real frontend, API and restricted database verification.');
    await page.getByLabel('Price in points', { exact: true }).fill('20');
    const starts = page.getByLabel('Start time (required)', { exact: true });
    await page.getByRole('button', { name: 'Create draft', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Create course', exact: true })).toBeVisible();
    assert.equal(await starts.evaluate(input => input.validity.valueMissing), true);
    assert.equal((await listings()).some(row => row.title === title), false);
    pass('real Trainer browser cannot create a video without a start time');
    await starts.fill('2099-05-01T09:30');
    await page.getByRole('button', { name: 'Create draft', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Course draft', exact: true })).toBeVisible();
    const saved = (await listings()).find(row => row.title === title);
    assert.ok(saved); assert.equal(saved.startsAt, '2099-05-01T01:30:00.000Z');
    await page.reload();
    await expect(starts).toHaveValue('2099-05-01T09:30');
    pass('real course form saves UTC start time through the API and database and restores it after reload');
    await page.goto(`${origin}/#/publishing-tools`);
    await page.getByLabel('Choose a listing').selectOption(saved.id);
    await expect(starts).toHaveValue('2099-05-01T09:30');
    await starts.fill('2099-05-02T10:15');
    await page.getByLabel('Reason or change summary (at least 5 characters)', { exact: true }).fill('Adjust the opening time for this test draft');
    await page.getByRole('button', { name: 'Review metadata update', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm change', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const edited = (await listings()).find(row => row.id === saved.id);
    assert.equal(edited.startsAt, '2099-05-02T02:15:00.000Z');
    assert.equal(edited.progressTrackingType, 'online_video');
    assert.deepEqual(edited.deliveryModes, ['cloud']);
    await page.reload();
    await page.getByLabel('Choose a listing').selectOption(saved.id);
    await expect(starts).toHaveValue('2099-05-02T10:15');
    pass('real Publishing tools update retains the video type and persists the edited start time');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await login('buyer@example.test');
    await setStart('2099-01-01T00:00:00.000Z');
    await page.goto(`${origin}/#/purchases`);
    await expect(page.getByLabel('Course video', { exact: true })).toHaveCount(0);
    await page.locator(`a[href="#/purchases/${item}/watch"]`).click();
    await expect(page).toHaveURL(new RegExp(`/purchases/${item}/watch`));
    await expect(page.getByRole('heading', { name: 'Your course opens soon', exact: true })).toBeVisible();
    await expect(page.getByLabel('Course video', { exact: true })).toHaveCount(0);
    pass('real My Learning entry leads to the dedicated page and a future course is locked');
    await setStart('2000-01-01T00:00:00.000Z');
    await page.getByRole('button', { name: 'Refresh course', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sync viewing progress', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Start time not set', exact: true })).toHaveCount(0);
    const video = page.getByLabel('Course video', { exact: true });
    await expect.poll(() => video.evaluate(media => media.readyState)).toBeGreaterThanOrEqual(2);
    const box = await video.boundingBox();
    await video.hover();
    await video.click({ position: { x: 25, y: box.height - 49 } });
    await expect.poll(() => video.evaluate(media => media.paused)).toBe(false);
    await expect.poll(() => video.evaluate(media => media.currentTime)).toBeGreaterThan(2);
    await video.click({ position: { x: 25, y: box.height - 49 } });
    await expect.poll(() => video.evaluate(media => media.paused)).toBe(true);
    await page.getByRole('button', { name: 'Sync viewing progress', exact: true }).click();
    await expect.poll(async () => (await delivery()).progress.uniqueContentWatchedSeconds).toBeGreaterThan(0);
    const learningProgress = page.getByLabel('Your learning progress', { exact: true });
    const displayedProgress = learningProgress.getByLabel(/^Server-confirmed unique viewing progress:/);
    await expect(displayedProgress).toBeVisible();
    await expect(learningProgress.getByText('Progress appears after the server confirms your viewing.', { exact: true })).toHaveCount(0);
    const displayedPercent = async () => Number((await displayedProgress.getAttribute('aria-label')).match(/: ([\d.]+)%$/)[1]);
    await expect.poll(displayedPercent).toBeGreaterThan(0);
    pass('real opened course supports native play, pause and server-confirmed progress');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sync viewing progress', exact: true })).toBeVisible();
    assert.equal((await delivery()).startsAt, '2000-01-01T00:00:00.000Z');
    await expect(displayedProgress).toBeVisible();
    await expect.poll(displayedPercent).toBeGreaterThan(0);
    const artifacts = join(appRoot, 'work/full-stack-video-artifacts'); await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, 'learning-desktop.png'), fullPage: true });
    await page.getByRole('link', { name: 'Back to My Learning', exact: true }).click();
    await expect(page).toHaveURL(/#\/purchases$/);
    pass('real purchased playback survives reload and returns to My Learning with the persisted start date');
    assert.equal(externalRequests, 0); pass('browser uses local frontend, real API and local media only');
    await context.close();
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
