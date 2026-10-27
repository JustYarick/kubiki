import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:1430';
const webkit = process.env.PLAYWRIGHT_BROWSER === 'webkit';
export default defineConfig({
  testDir: './tests/e2e', timeout: 30000,
  workers: process.env.PLAYWRIGHT_WORKERS ? Number(process.env.PLAYWRIGHT_WORKERS) : (process.env.CI ? 2 : 4),
  metadata: { fullLayout: process.env.E2E_FULL_LAYOUT === '1', diagnosticScreenshots: process.env.E2E_SCREENSHOTS === '1' },
  // Each file remains sequential; independent files run in parallel.
  reporter: [['list'], ['json', { outputFile: 'test-results/report.json' }]],
  // Never reuse the developer's live-cluster server. A custom base URL uses an
  // externally managed server (useful for targeted production-preview checks).
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: 'pnpm dev --host 127.0.0.1 --port 1430', url: baseURL, reuseExistingServer: false, timeout: 30000,
    env: { KUBECONFIG: fileURLToPath(new URL('./tests/fixtures/empty-kubeconfig.yaml', import.meta.url)) },
  },
  use: { baseURL, viewport: { width: 1440, height: 900 },
    browserName: webkit ? 'webkit' : 'chromium',
    launchOptions: webkit ? {} : { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined), args: ['--no-sandbox'] },
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
});
