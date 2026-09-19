import { defineConfig, devices } from '@playwright/test';
import original from './playwright.config.js';
export default defineConfig({
  ...original,
  testDir: 'tests/e2e',
  projects: [{ name: 'review-local-chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
  outputDir: 'review-test-results',
});
