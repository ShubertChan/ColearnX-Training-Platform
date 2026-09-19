import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e", timeout: 30000, fullyParallel: true, workers: 3,
  reporter: "list", outputDir: "test-results",
  use: { baseURL: "http://127.0.0.1:4178", trace: "off", screenshot: "only-on-failure", launchOptions: { timeout: 20000 } },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "node tests/e2e/server.mjs",
    url: "http://127.0.0.1:4178", reuseExistingServer: false,
    env: { VITE_API_BASE_URL: "/api/v1", VITE_ENABLE_HOSTED_VIDEO: "true", VITE_MEDIA_ORIGINS: "http://127.0.0.1:4178", VITE_UPLOAD_ORIGINS: "https://fixture.r2.cloudflarestorage.com" },
  },
});
