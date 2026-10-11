import { defineConfig } from '@playwright/test';
const prefix = (process.env.DOCS_PATH_PREFIX ?? '/').replace(/\/$/, '');
export default defineConfig({
  testDir: './test/docs-browser', timeout: 120_000, workers: 1,
  use: { baseURL: `http://127.0.0.1:8790${prefix}/`, headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined, trace: 'retain-on-failure' },
  webServer: { command: 'node ../../tools/serve-docs-test.mjs', url: `http://127.0.0.1:8790${prefix}/`, timeout: 10_000, reuseExistingServer: false },
});
