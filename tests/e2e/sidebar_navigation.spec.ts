import { captureScreenshot } from './helpers/screenshots';
import { test, expect, type Page } from '@playwright/test';

async function customApi(page: Page) {
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url());
    const operation = url.pathname.split('/').pop();
    if (operation === 'contexts') return route.fulfill({ json: [{ name: 'cluster', is_current: true }] });
    if (operation === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (operation === 'namespaces') return route.fulfill({ json: ['default'] });
    const items = url.searchParams.get('kind') === 'CustomResourceDefinition' ? ['first.example', 'second.example'].map(group => ({ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { uid: group, name: `widgets.${group}` }, spec: { group, names: { kind: 'Widget', plural: 'widgets' }, scope: 'Namespaced', versions: [{ name: 'v1', served: true, storage: true }] } })) : [];
    return route.fulfill({ json: { items } });
  });
}

test('fresh launches collapse categories and expose Lens-style direct cluster links and resource nesting', async ({ page }) => {
  await page.goto('/?demo=1');
  const explorer = page.getByTestId('explorer-panel');
  for (const label of ['Workloads', 'Config', 'Network', 'Storage', 'Helm', 'Access Control', 'Custom Resources']) {
    await expect(explorer.getByRole('button', { name: new RegExp(`^${label}(?: \\d+)?$`) })).toHaveAttribute('aria-expanded', 'false');
  }
  await expect(explorer.getByRole('button', { name: /^Pods(?: \d+)?$/ })).toHaveCount(0);
  await expect(explorer.getByRole('button', { name: /^Roles(?: \d+)?$/ })).toHaveCount(0);
  for (const label of ['Nodes', 'Namespaces', 'Events']) await expect(explorer.getByRole('button', { name: new RegExp(`^${label}(?: \\d+)?$`) })).toBeVisible();
  await expect(explorer.getByRole('button', { name: /^Cluster(?: \d+)?$/ })).toHaveCount(0);
  await captureScreenshot(page, { path: 'test-results/sidebar-collapsed.png', animations: 'disabled' });
  await explorer.getByRole('button', { name: /^Workloads(?: \d+)?$/ }).click();
  const workloads = explorer.locator('#sidebar-category-workloads');
  expect((await workloads.getByRole('button').allTextContents()).map(text => text.trim().replace(/\s*\d+$/, ''))).toEqual(['Pods', 'Deployments', 'DaemonSets', 'StatefulSets', 'ReplicaSets', 'Replication Controllers', 'Jobs', 'CronJobs']);
  await expect(explorer.getByRole('button', { name: 'Pods & controllers', exact: true })).toHaveCount(0);
  await explorer.getByRole('button', { name: /^Access Control(?: \d+)?$/ }).click();
  const access = explorer.locator('#sidebar-category-access');
  expect((await access.getByRole('button').allTextContents()).map(text => text.trim().replace(/\s*\d+$/, ''))).toEqual(['Service Accounts', 'Cluster Roles', 'Roles', 'Cluster Role Bindings', 'Role Bindings']);
  await expect(explorer.getByRole('button', { name: /^(Identity|Namespace RBAC|Cluster RBAC)$/ })).toHaveCount(0);
  await explorer.getByRole('button', { name: /^Nodes(?: \d+)?$/ }).click();
  await expect(page.getByTestId('resource-table').locator('tbody tr').first()).toBeVisible();
  await captureScreenshot(page, { path: 'test-results/sidebar-lens-navigation.png', animations: 'disabled' });
});

test('search temporarily reveals matching resource ancestors and clearing it restores collapsed categories', async ({ page }) => {
  await page.goto('/?demo=1');
  const explorer = page.getByTestId('explorer-panel');
  const filter = explorer.getByPlaceholder('Filter tree (e.g. pods, cm)…');
  await filter.fill('pods');
  await expect(explorer.getByRole('button', { name: /^Pods(?: \d+)?$/ })).toBeVisible();
  await expect(explorer.getByRole('button', { name: /^Workloads(?: \d+)?$/ })).toHaveAttribute('aria-expanded', 'true');
  await filter.fill('');
  await expect(explorer.getByRole('button', { name: /^Pods(?: \d+)?$/ })).toHaveCount(0);
  await expect(explorer.getByRole('button', { name: /^Workloads(?: \d+)?$/ })).toHaveAttribute('aria-expanded', 'false');
  await explorer.getByRole('button', { name: 'Expand All', exact: true }).click();
  await expect(explorer.getByRole('button', { name: /^Pods(?: \d+)?$/ })).toBeVisible();
  await explorer.getByRole('button', { name: 'Collapse All', exact: true }).click();
  await expect(explorer.getByRole('button', { name: /^Pods(?: \d+)?$/ })).toHaveCount(0);
});

test('switching resource tabs reveals and highlights the current type in the tree', async ({ page }) => {
  await page.goto('/?demo=1');
  const explorer = page.getByTestId('explorer-panel');
  await explorer.getByRole('button', { name: 'Expand All', exact: true }).click();
  await explorer.locator('[data-resource-type="Pod"]').click();
  await explorer.locator('[data-resource-type="ConfigMap"]').click();
  await expect(explorer.locator('[data-resource-type="ConfigMap"]')).toHaveAttribute('aria-current', 'page');
  await explorer.getByRole('button', { name: 'Collapse All', exact: true }).click();
  const tabs = page.getByRole('tablist', { name: 'Workspace tabs' });
  await tabs.getByRole('tab').filter({ hasText: 'Pods' }).click();
  await expect(explorer.locator('[data-resource-type="Pod"]')).toBeVisible();
  await expect(explorer.locator('[data-resource-type="Pod"]')).toHaveAttribute('aria-current', 'page');
  await tabs.getByRole('tab').filter({ hasText: 'ConfigMaps' }).click();
  await expect(explorer.locator('[data-resource-type="ConfigMap"]')).toBeVisible();
  await expect(explorer.locator('[data-resource-type="ConfigMap"]')).toHaveAttribute('aria-current', 'page');
  await expect(explorer.locator('[data-resource-type="Pod"]')).not.toHaveAttribute('aria-current', 'page');
});

test('custom resources nest by API group, groups start collapsed, and legacy expansion settings migrate once', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kubiki.settings.v3', JSON.stringify({ state: { uiScale: 120, sidebarGroups: { '*': true, workloads: true, crd: true } }, version: 0 })));
  await customApi(page);
  await page.goto('/');
  const explorer = page.getByTestId('explorer-panel');
  await expect(page.locator('html')).toHaveAttribute('data-ui-scale', '120');
  await expect(explorer.getByRole('button', { name: /^Workloads(?: \d+)?$/ })).toHaveAttribute('aria-expanded', 'false');
  await explorer.getByRole('button', { name: /^Custom Resources(?: \d+)?$/ }).click();
  await expect(explorer.getByRole('button', { name: /^Definitions(?: \d+)?$/ })).toBeVisible();
  await expect(explorer.getByRole('button', { name: 'first.example', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(explorer.getByRole('button', { name: 'Widget', exact: true })).toHaveCount(0);
  await explorer.getByRole('button', { name: 'first.example', exact: true }).click();
  await expect(explorer.getByRole('button', { name: 'Widget', exact: true })).toHaveCount(1);
  await explorer.getByRole('button', { name: 'Widget', exact: true }).click();
  await expect(page.getByTestId('resource-table')).toHaveAttribute('aria-label', 'Widget resource table');
  await expect(explorer.getByRole('button', { name: 'second.example', exact: true })).toHaveCount(1);
  await expect(explorer.getByRole('button', { name: 'second.example', exact: true })).toHaveAttribute('aria-expanded', 'false');
});

test('sidebar displays lightweight resource counts on connect without loading unopened collections', async ({ page }) => {
  const fullReads: string[] = [];
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url());
    const operation = url.pathname.split('/').pop();
    if (operation === 'contexts') return route.fulfill({ json: [{ name: 'cluster', is_current: true }] });
    if (operation === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (operation === 'namespaces') return route.fulfill({ json: ['default', 'payments'] });
    if (operation === 'resource-counts') {
      const ns = url.searchParams.get('namespace');
      return route.fulfill({ json: ns === 'payments' ? { Pod: 42, Deployment: 5, Secret: 12, Node: 18 } : { Pod: 9000, Deployment: 120, Secret: 340, Node: 18 } });
    }
    if (operation === 'resources') {
      const kind = url.searchParams.get('kind') ?? '';
      fullReads.push(kind);
    }
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto('/');
  const explorer = page.getByTestId('explorer-panel');
  await expect(explorer.getByRole('button', { name: 'Workloads 9120', exact: true })).toBeVisible();
  await expect(explorer.getByRole('button', { name: 'Nodes 18', exact: true })).toBeVisible();
  await explorer.getByRole('button', { name: 'Workloads 9120', exact: true }).click();
  await expect(explorer.getByRole('button', { name: 'Pods 9000', exact: true })).toBeVisible();
  await expect(explorer.getByRole('button', { name: 'Deployments 120', exact: true })).toBeVisible();
  expect(fullReads).not.toContain('Deployment');
  expect(fullReads).not.toContain('Secret');
});
