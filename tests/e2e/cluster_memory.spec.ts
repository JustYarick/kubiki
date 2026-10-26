import { test, expect } from '@playwright/test';

test('reopening the application reconnects to the selected cluster and restores its namespace scope', async ({ page }) => {
  const connections: string[] = [];
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/contexts')) return route.fulfill({ json: [
      { name: 'dev', cluster: 'dev', user: 'dev', is_current: true },
      { name: 'prod', cluster: 'prod', user: 'prod', is_current: false },
    ] });
    if (url.pathname.endsWith('/ping')) {
      connections.push(url.searchParams.get('context') ?? '');
      return route.fulfill({ json: { version: { gitVersion: 'v1.34.0' } } });
    }
    if (url.pathname.endsWith('/namespaces')) return route.fulfill({ json: ['backend'] });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto('/');
  await expect.poll(() => connections.at(-1)).toBe('dev');
  await page.getByRole('banner').getByTitle('Switch Kubernetes Cluster Context').click();
  await page.getByRole('group', { name: 'Actions', exact: true }).getByRole('button', { name: 'prod', exact: true }).click();
  await expect.poll(() => connections.at(-1)).toBe('prod');
  await page.evaluate(() => localStorage.setItem('kubiki.namespace.scopes.v1', JSON.stringify({ prod: 'backend' })));
  connections.length = 0;
  await page.reload();
  await expect.poll(() => connections.at(-1)).toBe('prod');
  expect(connections.every(context => context === 'prod')).toBe(true);
  await expect(page.getByRole('banner').getByTitle('Switch Kubernetes Cluster Context')).toContainText('prod');
  await expect(page.getByRole('banner').getByRole('button', { name: 'Namespace Scope', exact: true })).toContainText('backend');
});
