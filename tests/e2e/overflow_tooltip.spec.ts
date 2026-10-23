import { test, expect, type Page } from '@playwright/test';

const nodeName = 'ip-10-120-45-231.production-eu-central-1.compute.internal';
async function freezeClock(page: Page) {
  await page.clock.install({ time: new Date('2026-10-23T11:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-23T11:00:01Z'));
}
async function nodes(page: Page) {
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url()); const op = url.pathname.split('/').pop();
    if (op === 'contexts') return route.fulfill({ json: [{ name: 'prod', is_current: true }] });
    if (op === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (op === 'namespaces') return route.fulfill({ json: ['default'] });
    if (op === 'api-resources') return route.fulfill({ json: 'nodes no v1 false Node list' });
    return route.fulfill({ json: { items: url.searchParams.get('kind') === 'Node' ? [{ apiVersion: 'v1', kind: 'Node', metadata: { name: nodeName, uid: 'long-node' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }] : [] } });
  });
  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Nodes(?: \d+)?$/ }).click();
  const table = page.getByTestId('resource-table');
  await expect(table.getByText(nodeName, { exact: true })).toBeVisible();
  const resize = table.getByRole('separator', { name: 'Resize Name column', exact: true });
  await resize.focus();
  for (let index = 0; index < 12; index++) await resize.press('Shift+ArrowLeft');
  return table.getByText(nodeName, { exact: true });
}

test('a clipped node name appears only after half a second of stationary hover and escapes table clipping', async ({ page }) => {
  const name = await nodes(page);
  expect(await name.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await freezeClock(page);
  await name.hover();
  await page.clock.runFor(499);
  expect(await page.getByRole('tooltip').count()).toBe(0);
  await page.clock.runFor(2);
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toHaveText(nodeName);
  expect(await tooltip.evaluate(el => el.parentElement === document.body)).toBe(true);
  await expect(name).toHaveAttribute('aria-describedby', await tooltip.getAttribute('id') ?? '');
  await expect(name).not.toHaveAttribute('title');
  await page.keyboard.press('Escape');
  await expect(tooltip).toHaveCount(0);
  await expect(name).toHaveAttribute('title', nodeName);
});

test('movement restarts the delay; leaving or scrolling cancels it; full text gets no tooltip', async ({ page }) => {
  const name = await nodes(page);
  await freezeClock(page);
  await name.hover();
  await page.clock.runFor(300);
  const box = (await name.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.clock.runFor(300);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.mouse.move(1, 1);
  await page.clock.runFor(600);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await name.hover(); await page.clock.runFor(501);
  await expect(page.getByRole('tooltip')).toHaveText(nodeName);
  await page.getByTestId('resource-table').evaluate(el => el.dispatchEvent(new Event('scroll')));
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  const header = page.getByRole('columnheader', { name: 'Status', exact: true });
  await header.hover(); await page.clock.runFor(600);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('keyboard focus reveals clipped labels, viewport edges stay bounded, and detached labels close', async ({ page }) => {
  await nodes(page);
  await page.evaluate(() => {
    const button = document.createElement('button'); button.id = 'edge-label';
    button.textContent = 'a-very-long-resource-name-that-must-wrap-in-the-tooltip-at-the-right-edge-of-a-small-window';
    button.style.cssText = 'position:fixed;right:0;bottom:0;width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;z-index:150';
    document.body.append(button);
  });
  await freezeClock(page);
  await page.locator('#edge-label').focus(); await page.clock.runFor(501);
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toContainText('a-very-long-resource');
  const box = (await tooltip.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(8); expect(box.x + box.width).toBeLessThanOrEqual(1440 - 8);
  expect(box.y + box.height).toBeLessThanOrEqual(900 - 8);
  await tooltip.hover(); await page.clock.runFor(500);
  await expect(tooltip).toBeVisible();
  await page.locator('#edge-label').evaluate(el => el.remove());
  await expect(tooltip).toHaveCount(0);
});
