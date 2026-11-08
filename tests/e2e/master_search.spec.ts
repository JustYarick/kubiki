import { expect, test, type Page } from '@playwright/test';
import { namespaceList } from './helpers/namespaces';
import { captureScreenshot } from './helpers/screenshots';

async function setup(page: Page) {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url()); const op = url.pathname.split('/').pop(); const kind = url.searchParams.get('kind');
    if (op === 'contexts') return route.fulfill({ json: [{ name: 'test', is_current: true }, { name: 'stage', is_current: false }] });
    if (op === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (op === 'namespaces') return route.fulfill({ json: ['alpha', 'beta'] });
    if (op === 'api-resources') return route.fulfill({ json: 'pods po v1 true Pod get,list,watch\nconfigmaps cm v1 true ConfigMap get,list,watch\nsecrets sec v1 true Secret get,list,watch\ncustomresourcedefinitions crd apiextensions.k8s.io/v1 false CustomResourceDefinition get,list,watch\nnamespaces ns v1 false Namespace get,list,watch' });
    const raw = (kind: string, name: string, namespace: string, phase = 'Running') => ({ apiVersion: 'v1', kind, metadata: { uid: `${kind}/${name}`, name, namespace, labels: { app: 'web', cluster: url.searchParams.get('context') ?? 'test' } }, status: { phase } });
    if (op === 'custom-resources') return route.fulfill({ json: { items: [{ ...raw('Widget', 'custom-edge', 'beta'), apiVersion: 'example.io/v1' }] } });
    if (op === 'inventory') return route.fulfill({ json: [] });
    if (kind === 'Secret') return route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'Secrets access denied', retryable: false } } });
    let items: object[] = kind === 'Pod' ? [raw('Pod', 'web-api-12', 'alpha'), raw('Pod', 'web-jobs-9', 'beta', 'Failed'), raw('Pod', 'a'.repeat(50) + 'b', 'alpha')]
      : kind === 'ConfigMap' ? [raw('ConfigMap', 'unopened-config', 'beta')]
      : kind === 'Namespace' ? namespaceList(['alpha', 'beta']).items
      : kind === 'CustomResourceDefinition' ? [{ apiVersion: 'apiextensions.k8s.io/v1', kind, metadata: { name: 'widgets.example.io', uid: 'widget-definition' }, spec: { group: 'example.io', names: { kind: 'Widget', plural: 'widgets' }, scope: 'Namespaced', versions: [{ name: 'v1', served: true, storage: true }] } }] : [];
    const namespace = url.searchParams.get('namespace');
    if (namespace) items = items.filter((item: any) => !item.metadata.namespace || item.metadata.namespace === namespace);
    return route.fulfill({ json: { items } });
  });
  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  return errors;
}
async function open(page: Page) {
  await page.getByRole('button', { name: 'Search Everywhere', exact: true }).click();
  const search = page.getByRole('dialog', { name: 'Master search', exact: true });
  await search.getByRole('combobox', { name: 'Search category', exact: true }).selectOption('resources');
  return { search, query: search.getByRole('combobox', { name: 'Master search query', exact: true }), results: search.getByRole('listbox', { name: 'Search results', exact: true }) };
}

test('master search reads unopened kinds and CRDs across namespaces, shows partial access and opens the object', async ({ page }) => {
  const errors = await setup(page);
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();
  await page.getByRole('option', { name: 'alpha', exact: true }).click();
  await page.getByRole('button', { name: 'Apply namespaces', exact: true }).click();
  const { search, query, results } = await open(page);
  await query.fill('kind:ConfigMap ns:beta label:app=web');
  await expect(results.getByRole('option')).toHaveCount(1);
  await expect(results).toContainText('unopened-config');
  await expect(search.getByText(/Partial inventory/)).toBeVisible();
  await search.getByRole('combobox', { name: 'Search namespace scope', exact: true }).selectOption('selected');
  await expect(results.getByRole('option')).toHaveCount(0);
  await search.getByRole('combobox', { name: 'Search namespace scope', exact: true }).selectOption('all');
  await expect(results.getByRole('option')).toHaveCount(1);
  await captureScreenshot(page, { path: 'test-results/master-search.png' });
  await results.getByRole('option').click();
  const details = page.getByTestId('workspace-tab-panel').getByTestId('resource-details');
  await expect(details).toContainText('ConfigMap · beta');
  await expect(page.getByRole('button', { name: 'Namespace Scope', exact: true })).toContainText('alpha');
  const again = await open(page);
  await again.query.fill('kind:Widget name:custom-edge');
  await expect(again.results.getByRole('option')).toHaveCount(1);
  await expect(again.results).toContainText('example.io/v1');
  await again.results.getByRole('option').click();
  await expect(page.getByTestId('workspace-tab-panel').getByTestId('resource-details')).toContainText('custom-edge');
  expect(errors).toEqual([]);
});

test('master search supports regex, negative filters, case matching and invalid-expression recovery', async ({ page }) => {
  const errors = await setup(page);
  const { search, query, results } = await open(page);
  await search.getByRole('button', { name: 'Use regular expression', exact: true }).click();
  await query.fill('kind:^Pod$ name:^web-(api|jobs)-\\d+$ -status:Failed');
  await expect(results.getByRole('option')).toHaveCount(1);
  await expect(results).toContainText('web-api-12');
  await query.fill('[');
  await expect(search.getByRole('alert')).toBeVisible();
  await expect(results.getByRole('option')).toHaveCount(0);
  await query.fill('name:^WEB-API');
  await expect(results.getByRole('option')).toHaveCount(1);
  await search.getByRole('button', { name: 'Match case', exact: true }).press('Enter');
  await expect(results.getByRole('option')).toHaveCount(0);
  await search.getByRole('button', { name: 'Match case', exact: true }).press('Enter');
  await expect(results.getByRole('option')).toHaveCount(1);
  await query.press('ArrowDown'); await query.press('Enter');
  await expect(search).toHaveCount(0);
  await expect(page.getByTestId('workspace-tab-panel').getByTestId('resource-details')).toContainText('web-api-12');
  expect(errors).toEqual([]);
});

test('a pathological regex times out in its worker and the search stays usable', async ({ page }) => {
  await setup(page);
  const { search, query, results } = await open(page);
  await search.getByRole('button', { name: 'Use regular expression', exact: true }).click();
  await query.fill('name:^(a+)+$');
  await expect(search.getByRole('alert')).toContainText('Search took too long', { timeout: 8000 });
  await query.fill('name:^web-api-12$');
  await expect(results.getByRole('option')).toHaveCount(1);
  await expect(results).toContainText('web-api-12');
  await query.press('Escape'); await expect(search).toHaveCount(0);
});

test('master-search inventories remain isolated when the Kubernetes context changes', async ({ page }) => {
  await setup(page);
  const first = await open(page);
  await first.query.fill('kind:ConfigMap label:cluster=test');
  await expect(first.results.getByRole('option')).toHaveCount(1);
  await first.query.press('Escape');
  await page.getByTitle('Switch Kubernetes Cluster Context', { exact: true }).click();
  await page.getByText('stage', { exact: true }).click();
  const second = await open(page);
  await second.query.fill('kind:ConfigMap label:cluster=test');
  await expect(second.search.getByRole('status')).toContainText('Scanned');
  await expect(second.results.getByRole('option')).toHaveCount(0);
  await second.query.fill('kind:ConfigMap label:cluster=stage');
  await expect(second.results.getByRole('option')).toHaveCount(1);
});
