import { test, expect, type Page, type Locator } from '@playwright/test';

const release = { name: 'web-with-a-long-release-name-for-layout', namespace: 'backend', revision: '4', status: 'deployed', chart: 'web-chart-2026.10.21-preview.123', app_version: '2026.10', updated: '2026-10-21 09:00:00 +0300' };
async function fixture(page: Page) {
  const waits = new Map<string, Promise<void>>();
  await page.route('**/api/k8s/**', async route => {
    const url = new URL(route.request().url());
    const operation = url.pathname.split('/').pop()!;
    if (waits.has(operation)) await waits.get(operation);
    if (operation === 'contexts') return route.fulfill({ json: [{ name: 'production-long-context', is_current: true }] });
    if (operation === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (operation === 'namespaces') return route.fulfill({ json: ['backend', 'a-very-long-namespace-for-layout-testing'] });
    if (operation === 'releases') return route.fulfill({ json: { context: 'production-long-context', namespace: url.searchParams.get('namespace'), offset: 0, limit: 100, has_more: false, items: [release] } });
    if (operation === 'history') return route.fulfill({ json: [4, 3, 2, 1].map(revision => ({ ...release, revision, status: revision === 4 ? 'deployed' : 'superseded', description: 'Upgrade with a long description that stays inside its row' })) });
    if (operation === 'content') return route.fulfill({ json: 'replicas: 3\n' + 'key: long-value-for-horizontal-scrolling\n'.repeat(50) });
    const kind = url.searchParams.get('kind');
    const metadata = { name: 'owned-web', namespace: 'backend', uid: 'deployment', labels: { 'app.kubernetes.io/managed-by': 'Helm' }, annotations: { 'meta.helm.sh/release-name': release.name, 'meta.helm.sh/release-namespace': 'backend' } };
    return route.fulfill({ json: { items: kind === 'Deployment' ? [{ apiVersion: 'apps/v1', kind, metadata, spec: { replicas: 3 } }]
      : kind === 'Pod' ? [{ apiVersion: 'v1', kind, metadata: { name: 'web-pod', namespace: 'backend', uid: 'pod', ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'owned-web', uid: 'deployment' }] }, spec: { containers: [] }, status: { phase: 'Running' } }] : [] } });
  });
  return (operation: string) => {
    let resume!: () => void;
    waits.set(operation, new Promise<void>(resolve => { resume = resolve; }));
    return () => { waits.delete(operation); resume(); };
  };
}

async function open(page: Page) {
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByRole('button', { name: 'Open Helm Releases', exact: true }).click();
  if (await page.getByTestId('explorer-panel').isVisible()) await page.keyboard.press('ControlOrMeta+b');
  await page.getByTestId('helm-releases').getByRole('row', { name: `Inspect Helm release ${release.name} in backend` }).click({ position: { x: 12, y: 10 } });
  const details = page.getByTestId('inspector-panel').getByTestId('resource-details');
  await expect(details).toHaveAttribute('aria-busy', 'false');
  await expect(details.getByRole('region', { name: 'Release overview', exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return details;
}
async function box(locator: Locator) {
  return locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return [rect.x, rect.y, rect.width, rect.height].map(value => Math.round(value * 10) / 10);
  });
}

test('refresh retains panel and table geometry; changing resource kinds keeps one header height', async ({ page }) => {
  const hold = await fixture(page);
  const details = await open(page);
  const targets = [details.locator('.details-header'), details.getByRole('region', { name: 'Release overview', exact: true }), details.getByRole('region', { name: 'Managed Kubernetes objects', exact: true })];
  const before = await Promise.all(targets.map(box));
  const resume = hold('history');
  await details.getByRole('button', { name: 'Refresh release', exact: true }).click();
  await expect(details).toHaveAttribute('aria-busy', 'true');
  expect(await Promise.all(targets.map(box))).toEqual(before);
  resume();
  await expect(details).toHaveAttribute('aria-busy', 'false');
  expect(await Promise.all(targets.map(box))).toEqual(before);
  const list = page.getByTestId('helm-releases');
  const table = list.getByRole('table', { name: 'Helm release list' });
  const tableBefore = await box(table);
  const resumeList = hold('releases');
  await list.getByRole('button', { name: 'Refresh Helm releases', exact: true }).click();
  await expect(list).toHaveAttribute('aria-busy', 'true');
  expect(await box(table)).toEqual(tableBefore);
  resumeList();
  await expect(list).toHaveAttribute('aria-busy', 'false');
  expect(await box(table)).toEqual(tableBefore);
  await details.getByRole('button', { name: 'Inspect Deployment owned-web in backend', exact: true }).click();
  expect((await box(details.locator('.details-header')))[3]).toBe(before[0][3]);
  const scaler = details.locator('.details-scaler');
  const scalerBefore = await box(scaler);
  await details.getByRole('button', { name: 'Increase replicas', exact: true }).click();
  expect(await box(scaler)).toEqual(scalerBefore);
  await page.getByRole('button', { name: 'Toggle Explorer', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').getByText('web-pod', { exact: true }).click();
  expect((await box(details.locator('.details-header')))[3]).toBe(before[0][3]);
});

for (const { width, scale } of [{ width: 375, scale: 110 }, { width: 768, scale: 110 }, { width: 900, scale: 150 }, { width: 1440, scale: 200 }, { width: 1920, scale: 110 }, { width: 375, scale: 200 }]) {
  test(`details and menus fit ${width}px at ${scale}% scale`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(scale => localStorage.setItem('kubiki.settings.v3', JSON.stringify({ state: { uiScale: scale }, version: 0 })), scale);
    await fixture(page);
    const details = await open(page);
    const panel = page.getByTestId('inspector-panel');
    const bounds = await panel.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    expect(await details.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const close = await details.getByRole('button', { name: 'Close details', exact: true }).boundingBox();
    expect(close!.x + close!.width).toBeLessThanOrEqual(width);
    const settings = await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).boundingBox();
    expect(settings!.x + settings!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `test-results/details-overview-${width}-${scale}.png`, animations: 'disabled' });
    const header = await box(details.locator('.details-header'));
    await details.getByRole('tab', { name: 'History', exact: true }).click();
    await expect(details.getByRole('table', { name: 'Helm release history' })).toBeVisible();
    expect(await details.locator('.details-scroll').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await box(details.locator('.details-header'))).toEqual(header);
    await page.screenshot({ path: `test-results/details-history-${width}-${scale}.png`, animations: 'disabled' });
    await details.getByRole('tab', { name: 'Values', exact: true }).click();
    await expect(details.getByLabel('Helm values revision 4')).toBeVisible();
    expect(await box(details.locator('.details-header'))).toEqual(header);
    await details.getByRole('button', { name: 'More release actions', exact: true }).click();
    const menu = await page.getByRole('menu', { name: 'Release actions', exact: true }).boundingBox();
    expect(menu!.x).toBeGreaterThanOrEqual(0);
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape');
    await expect(details).toBeVisible();
    const overflow = details.getByRole('button', { name: 'Details panel actions', exact: true });
    const copy = details.getByRole('button', { name: 'Copy as…', exact: true });
    const trigger = await overflow.isVisible() ? overflow : copy;
    await trigger.click();
    const copyMenu = page.getByRole('menu', { name: await overflow.isVisible() ? 'Details panel actions' : 'Copy as…', exact: true });
    const copyBounds = await copyMenu.boundingBox();
    expect(copyBounds!.x).toBeGreaterThanOrEqual(0);
    expect(copyBounds!.x + copyBounds!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape');
    await expect(details).toBeVisible();
    await expect(trigger).toBeFocused();
    await page.screenshot({ path: `test-results/details-${width}-${scale}.png`, animations: 'disabled' });
    await details.getByRole('tab', { name: 'Overview', exact: true }).click();
    await details.getByRole('button', { name: 'Inspect Deployment owned-web in backend', exact: true }).click();
    const scaler = details.locator('.details-scaler');
    await scaler.scrollIntoViewIfNeeded();
    const scalerBefore = await box(scaler);
    await details.getByRole('button', { name: 'Increase replicas', exact: true }).click();
    expect(await box(scaler)).toEqual(scalerBefore);
    expect(await scaler.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: `test-results/details-workload-${width}-${scale}.png`, animations: 'disabled' });
  });
}
