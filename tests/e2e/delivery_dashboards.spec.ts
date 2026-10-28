import { captureScreenshot } from './helpers/screenshots';
import { test, expect, type Page } from '@playwright/test';

const definition = (group: string, kind: string, plural: string) => ({ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { uid: plural, name: `${plural}.${group}` }, spec: { group, names: { kind, plural }, scope: 'Namespaced', versions: [{ name: 'v1', served: true, storage: true }] } });
const crds = [definition('source.toolkit.fluxcd.io', 'GitRepository', 'gitrepositories'), definition('kustomize.toolkit.fluxcd.io', 'Kustomization', 'kustomizations'), definition('argoproj.io', 'Application', 'applications'), definition('argoproj.io', 'AppProject', 'appprojects')];
const object = (kind: string, name: string, group: string, namespace: string, spec: any, status: any) => ({ apiVersion: `${group}/v1`, kind, metadata: { name, namespace, uid: `${kind}-${name}` }, spec, status });

async function fixture(page: Page) {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url()); const op = url.pathname.split('/').pop();
    if (op === 'contexts') return route.fulfill({ json: [{ name: 'prod', is_current: true }] });
    if (op === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (op === 'namespaces') return route.fulfill({ json: ['backend', 'other'] });
    if (op === 'api-resources') return route.fulfill({ json: 'nodes no v1 false Node list\ncustomresourcedefinitions crd apiextensions.k8s.io/v1 false CustomResourceDefinition list' });
    if (op === 'resources') return route.fulfill({ json: { items: url.searchParams.get('kind') === 'CustomResourceDefinition' ? crds : [] } });
    if (op === 'custom-resources') {
      const name = url.searchParams.get('name');
      let items = name?.startsWith('gitrepositories') ? [object('GitRepository', 'platform-source', 'source.toolkit.fluxcd.io', 'backend', { url: 'https://example.com/platform/infrastructure.git' }, { conditions: [{ type: 'Ready', status: 'True' }] })]
        : name?.startsWith('kustomizations') ? [object('Kustomization', 'payments-production', 'kustomize.toolkit.fluxcd.io', 'backend', { sourceRef: { name: 'platform-source' } }, { conditions: [{ type: 'Ready', status: 'False', reason: 'DependencyNotReady' }] }), object('Kustomization', 'paused', 'kustomize.toolkit.fluxcd.io', 'other', { suspend: true }, {})]
        : name?.startsWith('applications') ? [object('Application', 'healthy-but-drifted', 'argoproj.io', 'backend', { project: 'production', destination: { namespace: 'backend' } }, { health: { status: 'Healthy' }, sync: { status: 'OutOfSync', revision: 'abc' } }), object('Application', 'synced-app', 'argoproj.io', 'other', { project: 'production' }, { health: { status: 'Healthy' }, sync: { status: 'Synced' } })]
        : [object('AppProject', 'production', 'argoproj.io', 'backend', { description: 'Production apps' }, {})];
      if (url.searchParams.get('namespace')) items = items.filter(item => item.metadata.namespace === url.searchParams.get('namespace'));
      return route.fulfill({ json: { items } });
    }
    if (op === 'inventory') return route.fulfill({ json: ['deployed', 'failed', 'pending-upgrade'].map((status, i) => ({ name: `release-${i}`, namespace: 'backend', revision: '2', chart: 'web-1.0', updated: '', app_version: '1', status })) });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  return errors;
}

test('Flux and Argo dashboards expose status filters, inspection and independent health and sync', async ({ page }) => {
  const errors = await fixture(page);
  await page.getByRole('button', { name: 'Open Flux Overview', exact: true }).click();
  const flux = page.getByTestId('flux-dashboard');
  await expect(flux.getByRole('button', { name: 'Kustomizations: 0 of 2 ready', exact: true })).toBeVisible();
  await expect(flux.locator('h1')).toHaveCount(0);
  await flux.getByRole('button', { name: 'Kustomizations: 0 of 2 ready', exact: true }).click();
  await expect(flux.getByRole('button', { name: /Inspect Kustomization payments-production/ })).toBeVisible();
  await expect(flux.getByRole('button', { name: /Inspect GitRepository/ })).toHaveCount(0);
  await flux.getByRole('button', { name: /Inspect Kustomization payments-production/ }).click();
  await expect(page.getByTestId('resource-details')).toContainText('payments-production');
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await flux.getByRole('button', { name: 'Clear dashboard filters' }).click();
  await flux.getByRole('textbox', { name: 'Search Flux resources' }).fill('platform-source');
  await expect(flux.getByRole('button', { name: /Inspect Kustomization payments-production/ })).toBeVisible();
  await page.getByRole('button', { name: 'Open Argo CD Overview', exact: true }).click();
  const argo = page.getByTestId('argocd-dashboard');
  await expect(argo.getByRole('button', { name: /2 Applications/ })).toBeVisible();
  await expect(argo.locator('h1')).toHaveCount(0);
  await expect(argo.getByRole('button', { name: 'Health Healthy: 2', exact: true })).toBeVisible();
  await expect(argo.getByRole('button', { name: 'Sync OutOfSync: 1', exact: true })).toBeVisible();
  await argo.getByRole('button', { name: 'Health Healthy: 2', exact: true }).click();
  await expect(argo.getByRole('button', { name: /Inspect Application healthy-but-drifted/ })).toBeVisible();
  await argo.getByRole('button', { name: 'Sync Synced: 1', exact: true }).click();
  await expect(argo.getByRole('button', { name: /Inspect Application healthy-but-drifted/ })).toHaveCount(0);
  await argo.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('tab', { name: /^Appprojects/ })).toBeVisible();
  await page.getByRole('button', { name: 'Open Argo CD Overview', exact: true }).click();
  await expect(page.getByRole('tab', { name: /^Argo CD Overview/ })).toHaveCount(1);
  await captureScreenshot(page, { path: 'test-results/argocd-dashboard.png' });
  expect(errors).toEqual([]);
});

test('Helm summary separates failed and pending operations without losing its revision inspection', async ({ page }) => {
  await fixture(page);
  await page.getByRole('button', { name: 'Open Helm Releases', exact: true }).click();
  const helm = page.getByTestId('helm-releases');
  await expect(helm.getByRole('button', { name: /Releases 3/ })).toBeVisible();
  await helm.getByRole('button', { name: /Failed 1/ }).click();
  await expect(helm.locator('tbody tr')).toHaveCount(1);
  await helm.getByRole('button', { name: /In progress 1/ }).click();
  await expect(helm.locator('tbody tr')).toHaveCount(1);
  await expect(helm.locator('tbody')).toContainText('pending-upgrade');
  await expect(helm).toContainText('Complete release inventory');
  await captureScreenshot(page, { path: 'test-results/helm-dashboard.png' });
});

test('dashboard snapshot errors retain known data and namespace changes replace the scope', async ({ page }) => {
  await fixture(page);
  await page.getByRole('button', { name: 'Open Flux Overview', exact: true }).click();
  const flux = page.getByTestId('flux-dashboard');
  await expect(flux.getByRole('button', { name: 'Kustomizations: 0 of 2 ready', exact: true })).toBeVisible();
  await expect(flux.locator('h1')).toHaveCount(0);
  await page.route('**/api/k8s/custom-resources?**', route => route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'Listing forbidden', status: 403, retryable: false } } }));
  await flux.getByRole('button', { name: 'Refresh Flux overview' }).click();
  await expect(flux).toContainText('Partial or stale data');
  await expect(flux.getByRole('button', { name: 'Kustomizations: unavailable', exact: true })).toBeVisible();
  await expect(flux.getByRole('button', { name: /Inspect Kustomization payments-production/ })).toBeVisible();
  await expect(flux.locator('h1')).toHaveCount(0);
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await page.getByRole('option', { name: 'other', exact: true }).click();
  await page.getByRole('button', { name: 'Apply namespaces', exact: true }).click();
  await expect(flux).toContainText('Resource data unavailable');
  await expect(flux.getByRole('button', { name: /Inspect Kustomization/ })).toHaveCount(0);
});

test('unavailable application data stays unknown even when project data is available', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/k8s/custom-resources?**', route => new URL(route.request().url()).searchParams.get('name')?.startsWith('applications.')
    ? route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'Application listing forbidden', status: 403, retryable: false } } })
    : route.fallback());
  await page.getByRole('button', { name: 'Open Argo CD Overview' }).click();
  const argo = page.getByTestId('argocd-dashboard');
  await expect(argo.getByRole('button', { name: /— Applications/ })).toBeVisible();
  await expect(argo.getByRole('button', { name: 'Health Healthy: unavailable', exact: true })).toBeVisible();
  await expect(argo).toContainText('Partial or stale data');
});

test('dashboards reflow on narrow workspaces with reduced motion and increased UI scale', async ({ page }) => {
  await fixture(page);
  await page.getByRole('button', { name: 'Open Flux Overview', exact: true }).click();
  await expect(page.getByTestId('flux-dashboard').getByRole('button', { name: 'Kustomizations: 0 of 2 ready', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Toggle Explorer', exact: true }).click();
  for (const width of [375, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    const view = page.getByTestId('flux-dashboard');
    expect(await view.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(view.getByRole('textbox')).toBeVisible();
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (let step = 0; step < 4; step++) await page.keyboard.press('Control+Equal');
  await expect(page.locator('html')).toHaveAttribute('data-ui-scale', '150');
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.getByTestId('flux-dashboard').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await captureScreenshot(page, { path: 'test-results/flux-dashboard-narrow.png' });
  for (let step = 0; step < 5; step++) await page.keyboard.press('Control+Equal');
  await expect(page.locator('html')).toHaveAttribute('data-ui-scale', '200');
  await page.keyboard.press('Control+b');
  await page.getByRole('button', { name: 'Open Argo CD Overview', exact: true }).click();
  await expect(page.getByTestId('argocd-dashboard').getByRole('button', { name: 'Health Healthy: 2', exact: true })).toBeVisible();
  await page.keyboard.press('Control+b');
  expect(await page.getByTestId('argocd-dashboard').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('GitOps refreshes automatically and controller events remain useful when event permissions are denied', async ({ page }) => {
  await page.clock.install();
  await fixture(page);
  let reads = 0;
  await page.route('**/api/k8s/custom-resources?**', route => { reads++;return route.fallback(); });
  await page.route('**/api/k8s/resources?**', route => {
    if (new URL(route.request().url()).searchParams.get('kind') !== 'Event') return route.fallback();
    return route.fulfill({ json: { items: [{ apiVersion: 'v1', kind: 'Event', metadata: { name: 'payment-source-failed', namespace: 'backend', uid: 'event-1' }, involvedObject: { kind: 'Kustomization', apiVersion: 'kustomize.toolkit.fluxcd.io/v1', name: 'payments-production', namespace: 'backend', uid: 'Kustomization-payments-production' }, type: 'Warning', reason: 'DependencyNotReady', message: 'Source is unavailable.', lastTimestamp: '2026-10-26T10:00:00Z' }] } });
  });
  await page.getByRole('button', { name: 'Open Flux Overview', exact: true }).click();
  const flux = page.getByTestId('flux-dashboard');
  await expect(flux.getByRole('button', { name: /Inspect event DependencyNotReady/ })).toBeVisible();
  const count = reads;
  await page.clock.fastForward(16000);
  await expect.poll(() => reads).toBeGreaterThan(count);
  await page.route('**/api/k8s/resources?**', route => new URL(route.request().url()).searchParams.get('kind') === 'Event' ? route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'Events listing forbidden', status: 403, retryable: false } } }) : route.fallback());
  await page.clock.fastForward(16000);
  await expect(flux).toContainText('Events listing forbidden');
  await expect(flux.getByRole('button', { name: /Inspect event DependencyNotReady/ })).toBeVisible();
  await expect(flux.getByRole('button', { name: 'Kustomizations: 0 of 2 ready' })).toBeVisible();
});
