import { test, expect } from '@playwright/test';

test('Used by follows roles to bindings to subjects, including identities and unloaded accounts', async ({ page }) => {
  const meta = (kind: string, name: string, namespace?: string) => ({ name, namespace, uid: `${kind}/${namespace}/${name}` });
  const roleRef = (kind: string, name: string) => ({ apiGroup: 'rbac.authorization.k8s.io', kind, name });
  const objects: Record<string, any[]> = {
    Role: [{ metadata: meta('Role', 'reader', 'backend') }],
    RoleBinding: [
      { metadata: meta('RoleBinding', 'read-local', 'backend'), roleRef: roleRef('Role', 'reader'), subjects: [
        { kind: 'ServiceAccount', name: 'app' },
        { kind: 'User', apiGroup: 'rbac.authorization.k8s.io', name: 'alice' },
        { kind: 'Group', apiGroup: 'rbac.authorization.k8s.io', name: 'developers' },
        { kind: 'ServiceAccount', name: 'app', namespace: 'unloaded' },
      ] },
      { metadata: meta('RoleBinding', 'read-cluster', 'backend'), roleRef: roleRef('ClusterRole', 'view'), subjects: [{ kind: 'ServiceAccount', name: 'app' }] },
      { metadata: meta('RoleBinding', 'read-other', 'other'), roleRef: roleRef('Role', 'reader') },
    ],
    ClusterRole: [{ metadata: meta('ClusterRole', 'view') }],
    ClusterRoleBinding: [{ metadata: meta('ClusterRoleBinding', 'read-global'), roleRef: roleRef('ClusterRole', 'view'), subjects: [{ kind: 'ServiceAccount', name: 'app', namespace: 'backend' }] }],
    ServiceAccount: [{ metadata: meta('ServiceAccount', 'app', 'backend') }],
    Pod: [{ metadata: meta('Pod', 'web', 'backend'), spec: { serviceAccountName: 'app', containers: [{ name: 'app' }] }, status: { phase: 'Running' } }],
  };
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url());
    const op = url.pathname.split('/').pop();
    if (op === 'contexts') return route.fulfill({ json: [{ name: 'prod', is_current: true }] });
    if (op === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (op === 'namespaces') return route.fulfill({ json: ['backend', 'other'] });
    const ns = url.searchParams.get('namespace');
    const allItems = objects[url.searchParams.get('kind') ?? ''] ?? [];
    return route.fulfill({ json: { items: allItems.filter(item => !ns || !item.metadata?.namespace || item.metadata.namespace === ns) } });
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await page.getByRole('button', { name: /^Roles(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').getByText('reader', { exact: true }).click();
  const details = page.getByTestId('resource-details');
  const usedBy = details.getByRole('region', { name: 'Used by', exact: true });
  await expect(usedBy).toContainText('Used by (1 consumer)');
  await expect(usedBy).not.toContainText('read-other');
  await usedBy.getByRole('button', { name: /read-local/ }).click();
  await expect(usedBy).toContainText('Used by (4 consumers)');
  await expect(usedBy.getByText('alice', { exact: true })).toBeVisible();
  await expect(usedBy.getByText('developers', { exact: true })).toBeVisible();
  await expect(usedBy.getByText('Not loaded', { exact: true })).toBeVisible();
  await expect(usedBy.getByRole('button')).toHaveCount(1);
  await usedBy.getByRole('button', { name: /ServiceAccount app backend/ }).click();
  await expect(usedBy.getByRole('button', { name: /Pod web backend/ })).toBeVisible();

  await page.getByRole('button', { name: /^Cluster Roles(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').getByText('view', { exact: true }).click();
  await expect(usedBy).toContainText('Used by (2 consumers)');
  await expect(usedBy.getByRole('button', { name: /read-cluster/ })).toBeVisible();
  await usedBy.getByRole('button', { name: /read-global/ }).click();
  await expect(usedBy).toContainText('Used by (1 consumer)');
  await expect(usedBy.getByRole('button', { name: /ServiceAccount app backend/ })).toBeVisible();
});
