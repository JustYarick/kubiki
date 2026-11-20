import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
async function developer(page: import('@playwright/test').Page) {
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Developer', exact: true }).click();
  return dialog;
}
test('developer mode owns the logging panel, exports a bounded sanitized buffer, and revokes late events', async ({ page }) => {
  const messages: string[] = [];
  page.on('console', message => { if (message.text().startsWith('[kubiki.diagnostics]')) messages.push(message.text()); });
  await page.goto('/?demo=1');
  await expect(page.getByRole('button', { name: 'Application Logs', exact: true })).toHaveCount(0);
  let dialog = await developer(page);
  await dialog.getByRole('checkbox', { name: 'Developer mode', exact: true }).check();
  await dialog.getByRole('button', { name: 'Open Application Logs', exact: true }).click();
  const logs = page.getByRole('region', { name: 'Application Logs', exact: true });
  await expect(logs.getByRole('heading', { name: 'Application Logs', exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve(),
      reason: { name: 'K8sRequestError', code: 'forbidden', status: 403, message: 'Bearer synthetic-private-token' } }));
  });
  await logs.getByRole('combobox', { name: 'Diagnostic minimum severity' }).selectOption('17');
  await expect(logs.getByRole('table').getByRole('row').filter({ hasText: 'runtime.rejection' })).toHaveCount(1);
  await logs.getByRole('table').getByRole('row').filter({ hasText: 'runtime.rejection' }).click();
  const detail = logs.getByRole('complementary', { name: 'Diagnostic event details' });
  await expect(detail).toContainText('forbidden');
  await expect(detail).not.toContainText('synthetic-private-token');
  await logs.getByRole('button', { name: 'Pause view', exact: true }).click();
  await page.evaluate(() => {
    window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve(),
      reason: new TypeError('synthetic-private-token') }));
  });
  await expect(logs.getByRole('table').getByRole('row').filter({ hasText: 'runtime.rejection' })).toHaveCount(1);
  const download = page.waitForEvent('download');
  await logs.getByRole('button', { name: 'Export JSONL' }).click();
  const exported = await download;
  expect(exported.suggestedFilename()).toMatch(/kubiki-diagnostics-.*\.jsonl$/);
  const jsonl = await readFile((await exported.path())!, 'utf8');
  const records = jsonl.trim().split('\n').map(line => JSON.parse(line));
  expect(records.some(record => record.eventName === 'diagnostics.enabled')).toBe(true);
  expect(records.filter(record => record.eventName === 'runtime.rejection')).toHaveLength(2);
  expect(jsonl).not.toContain('synthetic-private-token');
  await logs.getByRole('button', { name: 'Resume view', exact: true }).click();
  await expect(logs.getByRole('table').getByRole('row').filter({ hasText: 'runtime.rejection' })).toHaveCount(2);
  expect(messages.length).toBeGreaterThan(0);
  expect(messages.join('\n')).not.toContain('synthetic-private-token');
  dialog = await developer(page);
  await dialog.getByRole('checkbox', { name: 'Developer mode', exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Application Logs', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Application Logs Close tab', exact: true })).toHaveCount(0);
  const count = messages.length;
  await page.evaluate(() => {
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('synthetic-private-token') }));
  });
  expect(messages.length).toBe(count);
});

test('logging view contains horizontal scrolling and switches to detail overlay on narrow layouts', async ({ page }) => {
  await page.goto('/?demo=1');
  const dialog = await developer(page);
  await dialog.getByRole('checkbox', { name: 'Developer mode', exact: true }).check();
  await dialog.getByRole('button', { name: 'Open Application Logs', exact: true }).click();
  await page.setViewportSize({ width: 760, height: 900 });
  const logs = page.getByRole('region', { name: 'Application Logs', exact: true });
  await expect(logs).toBeVisible();
  expect(await logs.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const event = logs.getByRole('table').getByRole('row').filter({ hasText: 'diagnostics.enabled' });
  await event.click();
  const detail = logs.getByRole('complementary', { name: 'Diagnostic event details' });
  await expect(detail).toBeVisible();
  const bounds = await detail.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(760);
  await detail.getByRole('button', { name: 'Close diagnostic details' }).click();
  await expect(detail).toHaveCount(0);
});
