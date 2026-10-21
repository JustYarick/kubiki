import { openDiagramSettings } from './helpers/topology';
import { test, expect, type Page } from '@playwright/test';

const longName = 'web-api-production-with-a-long-resource-name-for-responsive-layout-testing';
async function fixture(page: Page) {
  const calls: URL[] = [];
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url()); calls.push(url);
    const operation = url.pathname.split('/').pop();
    if (operation === 'contexts') return route.fulfill({ json: [{ name: 'cluster', is_current: true }] });
    if (operation === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (operation === 'namespaces') return route.fulfill({ json: ['alpha', 'beta'] });
    if (operation === 'releases') return route.fulfill({ json: { context: 'cluster', namespace: url.searchParams.get('namespace'), offset: 0, limit: 100, has_more: false, items: [] } });
    const kind = url.searchParams.get('kind');
    const namespace = url.searchParams.get('namespace');
    const lists: Record<string, object[]> = {
      Pod: ['alpha', 'beta'].filter(name => !namespace || namespace === name).map(name => ({ apiVersion: 'v1', kind: 'Pod', metadata: { uid: `pod-${name}`, name: name === 'alpha' ? longName : 'other-web', namespace: name, managedFields: [{ manager: 'kubectl' }] }, spec: { nodeName: 'worker', containers: [{ name: 'web', image: 'nginx' }] }, status: { phase: 'Running' } })),
      Node: [{ apiVersion: 'v1', kind: 'Node', metadata: { uid: 'node', name: 'worker' } }],
      PersistentVolumeClaim: [{ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { uid: 'pvc', name: 'data', namespace: 'alpha' }, spec: {} }],
      CustomResourceDefinition: [{ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { uid: 'crd', name: 'widgets.example.com' }, spec: { group: 'example.com', names: { kind: 'Widget', plural: 'widgets' }, scope: 'Namespaced', versions: [{ name: 'v1', served: true, storage: true }] } }],
    };
    return route.fulfill({ json: { items: lists[kind ?? ''] ?? [] } });
  });
  return calls;
}
async function expand(page: Page) {
  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
}

test('All Namespaces draws the full graph from the namespace picker and the global selection', async ({ page }) => {
  const calls = await fixture(page); await expand(page);
  await page.getByRole('button', { name: 'Cluster topology', exact: true }).click();
    await expect(page.getByText('Choose a diagram scope', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'All Namespaces', exact: true }).click();
  await expect(page.locator('[data-namespace-group="alpha"]')).toBeVisible();
  await expect(page.locator('[data-namespace-group="beta"]')).toBeVisible();
  await expect(page.getByText('Choose a diagram scope', { exact: true })).toHaveCount(0);
  await openDiagramSettings(page);
  await page.getByRole('button', { name: 'Diagram namespaces', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Choose Diagram namespaces', exact: true });
  await menu.getByRole('option', { name: 'alpha', exact: true }).click();
  await menu.getByRole('button', { name: 'Apply namespaces', exact: true }).click();
  await expect(page.locator('[data-namespace-group="beta"]')).toHaveCount(0);
  await openDiagramSettings(page);
  await page.getByRole('button', { name: 'Diagram namespaces', exact: true }).click();
  await menu.getByRole('option', { name: 'All Namespaces', exact: true }).click();
  await menu.getByRole('button', { name: 'Apply namespaces', exact: true }).click();
  await expect(page.locator('.topology-view')).toHaveAttribute('data-scope', 'all');
  await expect(page.locator('[data-namespace-group="beta"]')).toBeVisible();
  expect(calls.filter(url => url.pathname.endsWith('/releases')).some(url => url.searchParams.get('namespace') === 'all')).toBe(false);

  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();
  const globalMenu = page.getByRole('dialog', { name: 'Choose Namespace Scope', exact: true });
  await globalMenu.getByRole('option', { name: 'alpha', exact: true }).click();
  await globalMenu.getByRole('button', { name: 'Apply namespaces', exact: true }).click();
  await page.getByRole('button', { name: 'Load all namespaces', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Namespace Scope', exact: true })).toHaveAttribute('data-value', 'all');
  await expect(page.locator('[data-namespace-group="beta"]')).toBeVisible();
});

for (const { width, scale } of [{ width: 375, scale: 110 }, { width: 768, scale: 150 }, { width: 1440, scale: 110 }, { width: 375, scale: 200 }]) {
  test(`YAML names and topology checkboxes fit ${width}px at ${scale}%`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(scale => localStorage.setItem('kubiki.settings.v3', JSON.stringify({ state: { uiScale: scale }, version: 0 })), scale);
    await fixture(page); await expand(page);
    await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
    const row = page.getByTestId('resource-table').locator('tbody tr').filter({ hasText: longName });
    const indicator = (await row.locator('[data-resource-issues]').boundingBox())!;
    const resourceName = (await row.locator(`span[title="${longName}"]`).boundingBox())!;
    expect(indicator.x + indicator.width).toBeLessThan(resourceName.x);
    await page.getByTestId('resource-table').getByText(longName, { exact: true }).click();
    const details = page.getByTestId('inspector-panel').getByTestId('resource-details');
    await details.getByRole('tab', { name: 'YAML', exact: true }).click();
    const editor = details.getByTestId('yaml-editor');
    await expect(editor.locator('.monaco-editor')).toBeVisible();
    const toolbar = editor.getByRole('group', { name: 'YAML editor toolbar', exact: true });
    const name = editor.locator('.yaml-resource-name');
    await expect(name).toHaveAttribute('title', `Pod/${longName}`);
    expect(await name.evaluate(element => ({ fits: element.clientWidth < element.scrollWidth, ellipsis: getComputedStyle(element).textOverflow }))).toEqual({ fits: true, ellipsis: 'ellipsis' });
    expect(await toolbar.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const apply = editor.getByRole('button', { name: 'Apply', exact: true });
    await expect(apply).toBeVisible(); await expect(apply).toBeDisabled();
    const more = editor.getByRole('button', { name: 'More YAML actions', exact: true });
    const fields = editor.getByRole('button', { name: 'Show server fields', exact: true });
    if (await more.isVisible()) {
      await more.click();
      await page.getByRole('menu', { name: 'YAML actions', exact: true }).getByRole('button', { name: 'Show server fields', exact: true }).click();
    } else await fields.click();
    await expect(editor.locator('.view-lines')).toContainText('managedFields');
    await expect(apply).toBeDisabled();
    await page.screenshot({ path: `test-results/yaml-responsive-${width}-${scale}.png`, animations: 'disabled' });
    await details.getByRole('button', { name: 'Close details', exact: true }).click();
    await page.getByRole('button', { name: 'Cluster topology', exact: true }).click();
    await expect(page.getByText('Choose a diagram scope', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'All Namespaces', exact: true }).click();
    if (await page.getByTestId('explorer-panel').isVisible()) await page.keyboard.press('ControlOrMeta+b');
    await expect(page.locator('.react-flow__node-resource')).toHaveCount(5);
    const settings = await openDiagramSettings(page);
    expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const types = page.getByRole('region', { name: 'Topology resource types', exact: true });
    await expect(types.getByRole('checkbox', { name: 'Show PersistentVolumeClaim', exact: true })).toBeVisible();
    const geometry = await types.locator('.ui-checkbox-row').evaluateAll(rows => rows.map(row => {
      const bounds = row.getBoundingClientRect();
      const checkbox = row.querySelector('input')!.getBoundingClientRect();
      const label = row.querySelector('.ui-checkbox-label')!.getBoundingClientRect();
      const count = row.querySelector('.ui-checkbox-trailing')!.getBoundingClientRect();
      return checkbox.x >= bounds.x && checkbox.right < label.x && label.right < count.x && count.right <= bounds.right && checkbox.y >= bounds.y && checkbox.bottom <= bounds.bottom;
    }));
    expect(geometry.length).toBe(5); expect(geometry.every(Boolean)).toBe(true);
    const popup = await types.locator('xpath=..').boundingBox();
    expect(popup!.x).toBeGreaterThanOrEqual(0); expect(popup!.x + popup!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `test-results/topology-types-${width}-${scale}.png`, animations: 'disabled' });
    await types.getByRole('checkbox', { name: 'Show PersistentVolumeClaim', exact: true }).uncheck();
    await expect(page.locator('.react-flow__node-resource')).toHaveCount(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
