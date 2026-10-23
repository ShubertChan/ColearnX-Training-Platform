import { expect, test } from '@playwright/test';

const json = (data) => ({ contentType: 'application/json', body: JSON.stringify({ data }) });
async function googleFixture(page) {
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/google/config')) return route.fulfill(json({ enabled: true, clientId: 'fixture.apps.googleusercontent.com' }));
    if (path.endsWith('/auth/google/challenge')) return route.fulfill(json({ nonce: 'nonce', expiresAt: new Date(Date.now() + 600000).toISOString() }));
    if (path.endsWith('/auth/google')) return route.fulfill(json({ registrationRequired: true }));
    if (path.endsWith('/auth/csrf')) return route.fulfill(json({ csrfToken: null }));
    return route.fulfill(json([]));
  });
  // Google itself needs a real configured origin and human account selection.
  // This fixture checks our production CSP allows loading its exact SDK URL,
  // then exercises the callback and language contract without cloud traffic.
  await page.route('https://accounts.google.com/gsi/client', (route) => route.fulfill({
    contentType: 'application/javascript', body: `window.google = { accounts: { id: {
      initialize(config) { window.googleFixtureConfig = config; },
      renderButton(container, options) {
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = options.locale === 'zh_CN' ? '使用 Google 登录' : 'Sign in with Google';
        button.style.cssText = 'width:100%;min-height:44px;border:1px solid #747775;border-radius:4px;background:#fff;color:#1f1f1f;font:500 14px Arial';
        button.onclick = () => window.googleFixtureConfig.callback({ credential: 'fixture-credential' });
        container.appendChild(button);
      }
    } } };`,
  }));
}

for (const width of [375, 768, 1440]) test(`Google sign-in translates and fits ${width}px`, async ({ page }) => {
  await googleFixture(page);
  await page.setViewportSize({ width, height: 950 });
  const response = await page.goto('/#/login');
  // A mocked SDK alone cannot detect a deployed document-header regression.
  // Google's real button iframe inherits this policy; the script attribute is
  // necessary for its own request but cannot override the iframe's policy.
  expect(response.headers()['referrer-policy']).toBe('strict-origin');
  const passwordButton = page.getByRole('button', { name: 'Sign in', exact: true });
  const googleButton = page.getByRole('button', { name: 'Sign in with Google', exact: true });
  await expect(googleButton).toBeVisible();
  await expect(page.locator('script[src="https://accounts.google.com/gsi/client"]')).toHaveAttribute('referrerpolicy', 'strict-origin');
  expect((await googleButton.boundingBox()).y).toBeGreaterThan((await passwordButton.boundingBox()).y);
  await page.getByLabel('Email address').fill('kept@gmail.com');
  await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
  await expect(page.getByRole('button', { name: '使用 Google 登录', exact: true })).toBeVisible();
  await expect(page.getByLabel('电子邮箱')).toHaveValue('kept@gmail.com');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (width === 1440) await page.screenshot({ path: 'test-results/google-login-desktop-zh.png', fullPage: true });
  if (width === 375) await page.screenshot({ path: 'test-results/google-login-mobile-zh.png', fullPage: true });
  await page.getByRole('button', { name: '使用 Google 登录', exact: true }).click();
  await expect(page.getByText('使用 Google 创建账号')).toBeVisible();
  await expect(page.getByRole('button', { name: '创建会员账户' })).toBeDisabled();
  expect(await page.evaluate(() => sessionStorage.getItem('colearnx-api-access-token'))).toBeNull();
});
