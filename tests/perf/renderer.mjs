import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

// Uses the same synthetic gesture and fixture as the GTK/Tauri probes. No cluster reads.
const fixture = JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['tests/perf/topology_fixture.py'], { encoding: 'utf8' }));
const script = await readFile(new URL('./native_pan.js', import.meta.url), 'utf8');
const url = process.env.BENCH_URL || 'http://127.0.0.1:1422';
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Only a loopback preview is allowed');
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome',
  headless: process.env.BENCH_HEADED !== '1',
  args: ['--no-sandbox', ...JSON.parse(process.env.BENCH_BROWSER_ARGS || '[]')],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route('**/api/**', route => {
    const request = new URL(route.request().url());
    const pathname = request.pathname;
    const json = pathname.endsWith('/contexts') ? [{ name: 'test', is_current: true }]
      : pathname.endsWith('/ping') ? { version: { gitVersion: 'v1.34.0' } }
      : pathname.endsWith('/namespaces') ? ['perf']
      : pathname.endsWith('/releases') ? { context: 'test', namespace: request.searchParams.get('namespace'), offset: 0, limit: 100, has_more: false, items: [] }
      : { items: fixture[request.searchParams.get('kind')] || [] };
    return route.fulfill({ json });
  });
  await page.goto(url);
  const result = await page.evaluate(({ script, config }) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Renderer benchmark timed out')), 45000);
    window.__kubikiBench = config;
    window.__kubikiFinish = data => { clearTimeout(timeout); resolve(data); };
    (0, eval)(script);
  }), { script, config: { mode: process.env.BENCH_MODE || 'pan', zoom: Number(process.env.BENCH_ZOOM || 5), frames: Number(process.env.BENCH_FRAMES || 180), variant: process.env.BENCH_VARIANT || 'default' } });
  console.log(JSON.stringify({ runtime: 'Chrome', browserVersion: browser.version(), headed: process.env.BENCH_HEADED === '1', result }));
  if (process.env.BENCH_SCREENSHOT) await page.screenshot({ path: process.env.BENCH_SCREENSHOT });
  if (result.error) process.exitCode = 1;
} finally {
  await browser.close();
}
