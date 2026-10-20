import { test, expect } from '@playwright/test';

for (const kind of ['Secret', 'ConfigMap']) test(`${kind} long values scroll internally without pushing subsequent keys away`, async ({ page }) => {
  const text = 'long configuration line\n'.repeat(500) + 'END-OF-VALUE';
  const data = { large: kind === 'Secret' ? Buffer.from(text).toString('base64') : text, next: kind === 'Secret' ? 'c21hbGw=' : 'small' };
  const item = { apiVersion: 'v1', kind, metadata: { uid: 'data-uid', name: 'large-data', namespace: 'default', resourceVersion: '1' }, data };
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/contexts')) return route.fulfill({ json: [{ name: 'test', is_current: true }] });
    if (url.pathname.endsWith('/ping')) return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (url.pathname.endsWith('/namespaces')) return route.fulfill({ json: ['default'] });
    return route.fulfill({ json: { items: url.searchParams.get('kind') === kind ? [item] : [] } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: kind === 'Secret' ? /^Secrets(?: \d+)?$/ : /^ConfigMaps(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').getByTitle('large-data', { exact: true }).click();
  const section = page.getByRole('region', { name: kind === 'Secret' ? 'Secret data' : 'Configuration data', exact: true });
  if (kind === 'Secret') await section.getByRole('button', { name: 'Reveal values' }).click();
  const value = section.getByLabel('Value for large', { exact: true });
  await expect(value).toHaveText(text);
  const metrics = await value.evaluate(el => ({ height: el.clientHeight, content: el.scrollHeight, overflow: getComputedStyle(el).overflowY }));
  expect(metrics.height).toBeLessThanOrEqual(360);expect(metrics.content).toBeGreaterThan(metrics.height * 5);expect(metrics.overflow).toBe('auto');
  await value.focus();await page.keyboard.press('Control+End');await expect.poll(() => value.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  const following = await section.getByLabel('Value for next', { exact: true }).boundingBox();const first = (await value.boundingBox())!;
  expect(following!.y - first.y).toBeLessThan(450);
  if (kind === 'Secret') {
    await section.getByRole('button', { name: 'Edit data' }).click();const input = section.getByRole('textbox', { name: 'Value 1', exact: true });
    await expect(input).toHaveValue(text);
    await input.evaluate(el => { el.style.height = '2000px'; });
    expect(await input.evaluate(el => el.clientHeight)).toBeLessThanOrEqual(360);
    expect(await input.evaluate(el => el.scrollHeight)).toBeGreaterThan(1000);
  }
});
