import { openDiagramSettings } from './helpers/topology';
import { test, expect, type Page } from '@playwright/test';

const groups = ['first.example', 'second.example'];
const definitions = groups.map(group => ({ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: `widgets.${group}`, uid: `crd-${group}` }, spec: { group, names: { kind: 'Widget', plural: 'widgets' }, scope: 'Namespaced', versions: [{ name: 'v1', served: true, storage: true, additionalPrinterColumns: [{ name: 'Endpoint', type: 'string', jsonPath: '.spec.endpoint' }, { name: 'Status', type: 'string', jsonPath: '.status.phase' }] }] } }));
async function fixture(page: Page, manyStatuses = false) {
  const calls: URL[] = [];
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url()); calls.push(url);
    const operation = url.pathname.split('/').pop();
    const namespace = url.searchParams.get('namespace');
    const namespaces = namespace ? [namespace] : ['alpha', 'beta', 'gamma'];
    if (operation === 'contexts') return route.fulfill({ json: [{ name: 'cluster', is_current: true }] });
    if (operation === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (operation === 'namespaces') return route.fulfill({ json: ['alpha', 'beta', 'gamma'] });
    if (operation === 'custom-resources') {
      const group = url.searchParams.get('name')!.slice('widgets.'.length);
      return route.fulfill({ json: { items: namespaces.map(namespace => ({ apiVersion: `${group}/v1`, kind: 'Widget', metadata: { uid: `${group}-${namespace}`, name: `${group}-${namespace}`, namespace }, spec: { endpoint: `https://${namespace}.${group}` }, status: { phase: 'Reconciling' } })) } });
    }
    if (operation === 'releases') return route.fulfill({ json: { context: 'cluster', namespace, offset: Number(url.searchParams.get('offset')), limit: 100, has_more: false, items: namespaces.map(namespace => ({ name: `release-${namespace}`, namespace, revision: '1', status: 'deployed', chart: 'chart-1', app_version: '1', updated: '' })) } });
    if (operation === 'history') return route.fulfill({ json: [] });
    if (operation === 'metrics') return route.fulfill({ json: { context: 'cluster', namespace, pods: { items: [], error: null }, nodes: { items: [], error: null } } });
    const kind = url.searchParams.get('kind');
    const statuses = manyStatuses ? ['Running', 'Pending', 'Succeeded', 'Failed', 'Unknown', 'ImagePullBackOff', 'CrashLoopBackOff'] : ['Running'];
    const items = kind === 'CustomResourceDefinition' ? definitions : kind === 'Namespace' ? ['alpha', 'beta', 'gamma'].map(name => ({ apiVersion: 'v1', kind, metadata: { uid: name, name } }))
      : kind === 'Pod' ? namespaces.flatMap(namespace => statuses.map((status, index) => ({ apiVersion: 'v1', kind, metadata: { uid: `${namespace}-${index}`, name: `${namespace}-${status}`, namespace }, spec: { containers: [{ name: 'app', image: 'nginx' }] }, status: { phase: ['ImagePullBackOff', 'CrashLoopBackOff'].includes(status) ? 'Pending' : status, containerStatuses: [{ name: 'app', ready: status === 'Running', state: ['ImagePullBackOff', 'CrashLoopBackOff'].includes(status) ? { waiting: { reason: status } } : { running: {} } }] } }))) : [];
    return route.fulfill({ json: { items } });
  });
  return calls;
}
async function select(page: Page, names: string[]) {
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Choose Namespace Scope', exact: true });
  await menu.getByRole('button', { name: 'Clear selection', exact: true }).click();
  for (const name of names) await menu.getByRole('option', { name, exact: true }).click();
  await menu.getByRole('button', { name: 'Apply namespaces', exact: true }).click();
}

test('global multi-namespace selection filters tables, Overview and Helm and builds grouped diagrams', async ({ page }) => {
  const calls = await fixture(page);
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await select(page, ['alpha', 'beta']);
  const selector = page.getByRole('button', { name: 'Namespace Scope', exact: true });
  await expect(selector).toHaveAttribute('data-value', '["alpha","beta"]');
  const table = page.getByTestId('resource-table');
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(table.getByText('gamma-Running', { exact: true })).toHaveCount(0);
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Open Overview', exact: true }).click();
  await expect(page.getByTestId('overview-count-Pod')).toHaveText('2');
  await expect(page.getByRole('heading', { name: 'Namespace overview' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Helm Releases', exact: true }).click();
  await expect(page.getByRole('row', { name: 'Inspect Helm release release-alpha in alpha', exact: true })).toBeVisible();
  await expect(page.getByRole('row', { name: 'Inspect Helm release release-beta in beta', exact: true })).toBeVisible();
  await expect(page.getByRole('row', { name: /Inspect Helm release release-gamma/ })).toHaveCount(0);
  const releaseCalls = calls.filter(url => url.pathname.endsWith('/releases'));
  expect(releaseCalls.map(url => url.searchParams.get('namespace'))).toEqual(expect.arrayContaining(['alpha', 'beta']));
  expect(releaseCalls.some(url => url.searchParams.get('namespace')?.startsWith('['))).toBe(false);
  await page.getByRole('button', { name: 'Cluster topology', exact: true }).click();
  await page.getByRole('button', { name: 'Use global selection', exact: true }).click();
  await expect(page.locator('[data-namespace-group="alpha"]')).toBeVisible();
  await expect(page.locator('[data-namespace-group="beta"]')).toBeVisible();
  await expect(page.locator('[data-namespace-group="gamma"]')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/multi-namespace-topology.png', animations: 'disabled' });
  await openDiagramSettings(page);
  await page.getByRole('button', { name: 'Diagram namespaces', exact: true }).click();
  const diagramMenu = page.getByRole('dialog', { name: 'Choose Diagram namespaces', exact: true });
  await diagramMenu.getByRole('option', { name: 'alpha', exact: true }).click();
  await diagramMenu.getByRole('button', { name: 'Apply namespaces', exact: true }).click();
  await expect(page.locator('[data-namespace-group="alpha"]')).toHaveCount(0);
  await expect(page.locator('[data-namespace-group="beta"]')).toBeVisible();
  await expect(selector).toHaveAttribute('data-value', '["alpha","beta"]');
  await page.screenshot({ path: 'test-results/multi-namespace-topology.png', animations: 'disabled' });
});

test('custom kinds have independent group-aware tables, CRD printer columns and reusable details', async ({ page }) => {
  await fixture(page);
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  const explorer = page.getByTestId('explorer-panel');
  await explorer.getByRole('button', { name: 'Widget', exact: true }).first().click();
  const table = page.getByTestId('resource-table');
  await expect(table.getByRole('columnheader', { name: 'Endpoint', exact: true })).toBeVisible();
  await expect(table.getByText('first.example-alpha', { exact: true })).toBeVisible();
  await expect(table.getByText('second.example-alpha', { exact: true })).toHaveCount(0);
  await table.getByText('first.example-alpha', { exact: true }).click();
  const details = page.getByTestId('inspector-panel').getByTestId('resource-details');
  await expect(details.getByText('Widget · alpha', { exact: true })).toBeVisible();
  await expect(details.getByRole('region', { name: 'Specification', exact: true })).toContainText('https://alpha.first.example');
  await details.getByRole('button', { name: 'Open details in tab', exact: true }).click();
  await expect(page.getByTestId('workspace-tab-panel').getByTestId('resource-details')).toContainText('first.example-alpha');
  await expect(page.getByTestId('inspector-panel').getByTestId('resource-details')).toContainText('first.example-alpha');
  await page.reload();
  await expect(page.getByTestId('workspace-tab-panel').getByTestId('resource-details')).toContainText('first.example-alpha');
  await explorer.getByRole('button', { name: /^Widget(?: \d+)?$/ }).last().click();
  await expect(table.getByText('second.example-alpha', { exact: true })).toBeVisible();
  await expect(table.getByText('first.example-alpha', { exact: true })).toHaveCount(0);
  await select(page, ['alpha', 'beta']);
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(table.getByText('second.example-gamma', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/custom-resource-tables.png', animations: 'disabled' });
});

test('the status header can prioritize every observed status without hiding other rows', async ({ page }) => {
  await fixture(page, true);
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await select(page, ['alpha']);
  const table = page.getByTestId('resource-table');
  await expect(table.locator('tbody tr')).toHaveCount(7);
  for (const status of ['Running', 'Pending', 'Succeeded', 'Failed', 'Unknown', 'ImagePullBackOff', 'CrashLoopBackOff']) {
    await table.getByRole('columnheader', { name: 'Status', exact: true }).click();
    await page.getByRole('button', { name: `Show ${status} first`, exact: true }).click();
    await expect(table.locator('tbody tr').first()).toContainText(`alpha-${status}`);
    await expect(table.locator('tbody tr')).toHaveCount(7);
    await expect(table.getByRole('columnheader', { name: 'Status', exact: true })).toHaveAttribute('aria-sort', 'other');
  }
  await table.getByRole('columnheader', { name: 'Status', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Clear sorting', exact: true }).click();
  await expect(table.getByRole('columnheader', { name: 'Status', exact: true })).toHaveAttribute('aria-sort', 'none');
});
