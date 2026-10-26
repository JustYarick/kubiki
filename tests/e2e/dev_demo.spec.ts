import { test, expect } from '@playwright/test';

test('empty kubeconfig starts the expanded demo with Developer mode disabled', async ({ page }) => {
  const errors: string[] = [];const liveReads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/api\/k8s\/(resources|namespaces|custom-resources|ping|helm\/)/.test(request.url())) liveReads.push(request.url()); });
  await page.goto('/');
  await expect(page.getByText('Demo cluster · simulated resources and sessions', { exact: true })).toBeVisible();
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByRole('button', { name: 'Open Flux Overview', exact: true }).click();
  await expect(page.getByTestId('flux-dashboard').getByRole('button', { name: 'Kustomizations: 2 of 5 ready' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Argo CD Overview', exact: true }).click();
  await expect(page.getByTestId('argocd-dashboard').getByRole('button', { name: 'Health Healthy: 3' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Helm Releases', exact: true }).click();
  await expect(page.getByTestId('helm-releases').getByRole('button', { name: /Releases 8/ })).toBeVisible();
  await page.getByRole('row', { name: 'Inspect Helm release loki in logging', exact: true }).click();
  const details = page.getByTestId('resource-details');
  await expect(details).toContainText('BackoffLimitExceeded');
  await expect(details).toContainText('Managed by Flux');
  await expect(details.getByRole('button', { name: 'Upgrade', exact: true })).toBeDisabled();
  expect(liveReads).toEqual([]);expect(errors).toEqual([]);
});

test('Developer mode adds demo immediately and disabling it reconnects to a real context', async ({ page }) => {
  const contexts = [{ name: 'prod', is_current: true }, { name: 'stage', is_current: false }];
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url());const op = url.pathname.split('/').pop();
    if (op === 'contexts') return route.fulfill({ json: contexts });
    if (op === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (op === 'namespaces') return route.fulfill({ json: ['backend'] });
    if (op === 'api-resources') return route.fulfill({ json: 'pods po v1 true Pod list' });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto('/');
  const selector = page.getByTitle('Switch Kubernetes Cluster Context', { exact: true });
  await expect(selector).toContainText('prod');
  await expect(page.getByText('Demo cluster · simulated resources and sessions', { exact: true })).toHaveCount(0);
  await selector.click();
  await expect(page.getByText('stage', { exact: true })).toBeVisible();
  await expect(page.getByText('kubiki-demo', { exact: true })).toHaveCount(0);
  await page.getByText('stage', { exact: true }).click();
  await expect(selector).toContainText('stage');
  await selector.click();
  await expect(page.getByText('kubiki-demo', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const developerMode = async (enabled: boolean) => {
    await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Developer', exact: true }).click();
    await dialog.getByRole('checkbox', { name: 'Developer mode', exact: true }).setChecked(enabled);
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  };
  await developerMode(true);
  await expect(selector).toContainText('stage');
  await selector.click();
  await page.getByText('kubiki-demo', { exact: true }).click();
  await expect(page.getByText('Demo cluster · simulated resources and sessions', { exact: true })).toBeVisible();
  await page.reload();
  await expect(selector).toContainText('kubiki-demo');
  await expect(page.getByText('Demo cluster · simulated resources and sessions', { exact: true })).toBeVisible();
  await developerMode(false);
  await expect(selector).toContainText('prod');
  await expect(page.getByText('Demo cluster · simulated resources and sessions', { exact: true })).toHaveCount(0);
  await selector.click();
  await expect(page.getByText('stage', { exact: true })).toBeVisible();
  await expect(page.getByText('kubiki-demo', { exact: true })).toHaveCount(0);
});
