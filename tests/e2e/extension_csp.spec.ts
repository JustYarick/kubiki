import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const csp = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).app.security.csp as string;

test('extension bundles run under desktop CSP while parent scripts and panel network stay blocked', async ({ page }) => {
  // Reproduce Tauri's per-document nonce replacement and CSP augmentation.
  const nonce = 'syntheticRuntimeNonce123';
  const policy = csp.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`);
  let externalRequests = 0;
  await page.route('**/forbidden.js', route => { externalRequests++; return route.fulfill({ body: '' }); });
  await page.route('**/extension-csp-fixture', route => route.fulfill({
    contentType: 'text/html',
    body: `<meta http-equiv="Content-Security-Policy" content="${policy}">
      <meta name="kubiki-panel-nonce" content="${nonce}">
      <script>window.unapprovedParentScript = true</script>
      <iframe title="test panel" sandbox="allow-scripts allow-forms"></iframe>`,
  }));
  await page.goto('/extension-csp-fixture');
  await page.evaluate(async () => {
    const modulePath = '/src/extensions/panel_document.ts';
    const { sandboxDocument } = await import(/* @vite-ignore */ modulePath);
    const html = `<body><div id="result">waiting</div><script>
      document.querySelector('#result').textContent = 'bundle ran';
      try { parent.document.body.dataset.accessed = 'yes'; } catch { document.body.dataset.isolated = 'yes'; }
      fetch('http://127.0.0.1:1430/forbidden-fetch').catch(() => { document.body.dataset.network = 'blocked'; });
      const script = document.createElement('script');
      script.nonce = document.currentScript.nonce;
      script.src = 'http://127.0.0.1:1430/forbidden.js';
      document.body.append(script);
    </script><script src="http://127.0.0.1:1430/forbidden.js"></script></body>`;
    document.querySelector('iframe')!.srcdoc = sandboxDocument(html);
  });
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#result')).toHaveText('bundle ran');
  await expect(frame.locator('body')).toHaveAttribute('data-isolated', 'yes');
  await expect(frame.locator('body')).toHaveAttribute('data-network', 'blocked');
  expect(await page.evaluate(() => (window as any).unapprovedParentScript)).toBeUndefined();
  expect(externalRequests).toBe(0);
});
