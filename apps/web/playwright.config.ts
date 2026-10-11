import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser', timeout: 30_000, fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:8786', headless: true, trace: 'retain-on-failure',
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined },
  webServer: { command: 'node test/browser-server.mjs', url: 'http://127.0.0.1:8786/ui/', reuseExistingServer: false, timeout: 30_000 },
});
