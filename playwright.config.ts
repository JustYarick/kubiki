import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const webkit = process.env.PLAYWRIGHT_BROWSER === 'webkit';
export default defineConfig({
  testDir: './tests/e2e', timeout: 30000, workers: 1,
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:1420', viewport: { width: 1440, height: 900 },
    browserName: webkit ? 'webkit' : 'chromium',
    launchOptions: webkit ? {} : { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined), args: ['--no-sandbox'] },
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
});
