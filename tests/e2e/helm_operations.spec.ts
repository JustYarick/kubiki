import { captureScreenshot } from './helpers/screenshots';
import { openDiagramSettings } from './helpers/topology';
import { test, expect } from '@playwright/test';

test('desktop Helm edit/install/rollback/uninstall and repository CRUD use backend-reviewed requests', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    let releases = [{ name: 'web', namespace: 'backend', revision: '2', updated: '', status: 'deployed', chart: 'web-1', app_version: '1' }];
    let repos = [{ name: 'demo', url: 'https://old.example/charts' }];
    w.__helmWrites = [];
    w.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command: string, args: any = {}) => {
      if (command === 'get_kube_contexts') return [{ name: 'prod', is_current: true }];
      if (command === 'ping_cluster') return { git_version: 'v1.35.0' };
      if (command === 'get_namespaces') return ['backend'];
      if (command === 'get_resources') return { items: [] };
      if (command.startsWith('stop_') || command === 'watch_resources') return;
      if (command === 'list_helm_releases') return { ...args, limit: 100, has_more: false, items: [...releases] };
      if (command === 'list_helm_repositories') return [...repos];
      if (command === 'get_helm_history') return Array.from({ length: Number(releases[0].revision) }, (_, index) => ({ revision: index + 1, updated: '', status: index + 1 === Number(releases[0].revision) ? 'deployed' : 'superseded', chart: 'web-1', app_version: '1', description: 'Fixture revision' }));
      if (command === 'get_helm_content') return 'replicaCount: 2\n';
      if (command === 'search_helm_charts') return [{ name: 'demo/web', version: '1.2.0', app_version: '1', description: 'test chart' }];
      if (command === 'mutate_resource' && args.request.operation === 'helm') {
        const r = args.request.request; w.__helmWrites.push(r);
        if (r.operation === 'install') releases.push({ ...releases[0], name: r.name, namespace: r.namespace, revision: '1' });
        if (r.operation === 'upgrade' || r.operation === 'rollback') releases = releases.map(item => item.name === r.name ? { ...item, revision: String(Number(item.revision) + 1) } : item);
        if (r.operation === 'uninstall') releases = releases.filter(item => item.name !== r.name);
        if (r.operation === 'repository_set') repos = [...repos.filter(item => item.name !== r.name), { name: r.name, url: r.url }];
        if (r.operation === 'repository_remove') repos = repos.filter(item => item.name !== r.name);
        return { message: 'Completed fixture operation' };
      }
      throw new Error(`Unexpected command ${command}`);
    } };
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByRole('button', { name: 'Open Helm Releases', exact: true }).click();
  const view = page.getByTestId('helm-releases');
  const details = page.getByTestId('inspector-panel').getByTestId('resource-details');
  await view.getByRole('row', { name: 'Inspect Helm release web in backend' }).click();
  await details.getByRole('button', { name: 'Upgrade', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Upgrade Helm release', exact: true });
  await expect(dialog.getByLabel('Helm values YAML')).toHaveValue('replicaCount: 2\n');
  await dialog.getByLabel('Helm chart reference').fill('demo/web');
  await dialog.getByRole('button', { name: 'Find charts', exact: true }).click();
  await dialog.getByRole('button', { name: 'demo/web 1.2.0', exact: true }).click();
  await dialog.getByLabel('Helm values YAML').fill('replicaCount: 4\n');
  await dialog.getByRole('button', { name: 'Review in system dialog' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(details.getByRole('region', { name: 'Release overview' }).getByText('3', { exact: true })).toBeVisible();
  await details.getByRole('tab', { name: 'History', exact: true }).click();
  await expect(details.getByRole('button', { name: 'Restore Helm revision 3', exact: true })).toBeDisabled();
  await captureScreenshot(page, { path: 'test-results/helm-history-actions.png', animations: 'disabled' });
  await details.getByRole('button', { name: 'Restore Helm revision 1', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Roll back Helm release' }); await expect(dialog.getByLabel('Helm rollback revision')).toHaveValue('1');
  await dialog.getByRole('button', { name: 'Review in system dialog' }).click(); await expect(dialog).toHaveCount(0);
  await view.getByRole('button', { name: 'Install release', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Install Helm release' }); await dialog.getByLabel('Helm release name').fill('second'); await dialog.getByLabel('Helm target namespace').fill('backend'); await dialog.getByLabel('Helm chart reference').fill('demo/web');
  await dialog.getByRole('button', { name: 'Review in system dialog' }).click(); await expect(dialog).toHaveCount(0);
  await expect(view.getByRole('row', { name: 'Inspect Helm release second in backend' })).toBeVisible();
  await details.getByRole('button', { name: 'More release actions', exact: true }).click(); await page.getByRole('menu', { name: 'Release actions' }).getByRole('button', { name: 'Uninstall', exact: true }).click(); dialog = page.getByRole('dialog', { name: 'Uninstall Helm release' });
  await dialog.getByRole('button', { name: 'Review in system dialog' }).click(); await expect(view.getByRole('row', { name: 'Inspect Helm release web in backend' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Helm Repositories' }).click();
  const repositories = page.getByTestId('helm-repositories'); await repositories.getByRole('row', { name: 'Helm repository demo' }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Edit repository…' }).click(); dialog = page.getByRole('dialog', { name: 'Configure Helm repository' });
  await dialog.getByLabel('Helm repository URL').fill('https://new.example/charts'); await dialog.getByRole('button', { name: 'Review in system dialog' }).click();
  await expect(repositories).toContainText('https://new.example/charts');
  await repositories.getByRole('button', { name: 'More repository actions', exact: true }).click(); await page.getByRole('menu', { name: 'Repository actions' }).getByRole('button', { name: 'Update indexes' }).click(); dialog = page.getByRole('dialog', { name: 'Update Helm repository cache' }); await dialog.getByRole('button', { name: 'Review in system dialog' }).click(); await expect(dialog).toHaveCount(0);
  await repositories.getByRole('row', { name: 'Helm repository demo' }).click({ button: 'right' }); await page.getByRole('button', { name: 'Remove repository…' }).click();
  dialog = page.getByRole('dialog', { name: 'Remove Helm repository' }); await dialog.getByRole('button', { name: 'Review in system dialog' }).click(); await expect(repositories).toContainText('No repositories configured');
  await repositories.getByRole('button', { name: 'Add repository' }).click(); dialog = page.getByRole('dialog', { name: 'Configure Helm repository' });
  await dialog.getByLabel('Helm repository name').fill('other'); await dialog.getByLabel('Helm repository URL').fill('https://other.example/charts'); await dialog.getByRole('button', { name: 'Review in system dialog' }).click(); await expect(repositories).toContainText('https://other.example/charts');
  const writes = await page.evaluate(() => (window as any).__helmWrites);
  expect(writes[0]).toMatchObject({ operation: 'upgrade', expected_revision: 2, chart: 'demo/web', chart_version: '1.2.0', values: 'replicaCount: 4\n', context: 'prod', namespace: 'backend', run_hooks: false });
  expect(writes[1]).toMatchObject({ operation: 'rollback', expected_revision: 3, revision: 1 });
  expect(writes[4]).toMatchObject({ operation: 'repository_set', previous_url: 'https://old.example/charts', url: 'https://new.example/charts' });
  expect(writes).toHaveLength(8);
});

test('RBAC diagrams show declared chains; Helm nodes connect to owned objects and open release details', async ({ page }) => {
  const workers: string[] = []; page.on('request', request => { if (request.url().includes('layout_worker')) workers.push(request.url()); });
  const release = { name: 'web', namespace: 'backend', revision: '2', updated: '', status: 'deployed', chart: 'web-1', app_version: '1' };
  const meta = (name: string, namespace?: string) => ({ name, namespace, uid: `${namespace}/${name}` });
  const objects: Record<string, any[]> = {
    Namespace: [{ metadata: meta('backend') }],
    ServiceAccount: [{ metadata: meta('app', 'backend') }],
    Role: [{ metadata: meta('reader', 'backend'), rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get'] }] }],
    RoleBinding: [{ metadata: meta('read', 'backend'), roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'reader' }, subjects: [{ kind: 'ServiceAccount', name: 'app', namespace: 'backend' }] }],
    Pod: [{ metadata: meta('pod-web', 'backend'), spec: { serviceAccountName: 'app', containers: [{ name: 'app' }] }, status: { phase: 'Running' } }],
    Deployment: [{ metadata: { ...meta('web', 'backend'), labels: { 'app.kubernetes.io/managed-by': 'Helm' }, annotations: { 'meta.helm.sh/release-name': 'web', 'meta.helm.sh/release-namespace': 'backend' } }, spec: { replicas: 0 } }],
  };
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url()); const op = url.pathname.split('/').pop();
    if (op === 'contexts') return route.fulfill({ json: [{ name: 'prod', is_current: true }] });
    if (op === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (op === 'namespaces') return route.fulfill({ json: ['backend'] });
    if (url.pathname.includes('/helm/') && op === 'releases') return route.fulfill({ json: { context: 'prod', namespace: url.searchParams.get('namespace'), offset: 0, limit: 100, has_more: false, items: [release] } });
    if (url.pathname.includes('/helm/') && op === 'history') return route.fulfill({ json: [{ revision: 2, status: 'deployed', chart: 'web-1', app_version: '1', updated: '', description: '' }] });
    return route.fulfill({ json: { items: objects[url.searchParams.get('kind') ?? ''] ?? [] } });
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByRole('button', { name: /^Roles(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').getByText('reader', { exact: true }).click(); await page.getByTestId('resource-details').getByRole('button', { name: 'Topology', exact: true }).click();
  await openDiagramSettings(page);
  await page.getByLabel('Relationship depth').selectOption('3');
  await expect(page.locator('.react-flow__node-resource').getByText('RoleBinding', { exact: true })).toBeVisible();
  await expect(page.locator('.react-flow__node-resource').getByText('ServiceAccount', { exact: true })).toBeVisible();
  await expect(page.locator('.react-flow__node-resource').getByText('Pod', { exact: true })).toBeVisible();
  const types = page.getByRole('region', { name: 'Topology resource types' });
  const pod = page.locator('.react-flow__node-resource').filter({ has: page.locator('[data-resource-kind="Pod"]') });
  const position = await pod.getAttribute('style'); const workerCount = workers.length;
  const canvas = page.locator('.topology-canvas'); const bounds = await canvas.boundingBox();
  await expect(types).toBeVisible();
  expect(await canvas.boundingBox()).toEqual(bounds);
  await types.getByLabel('Show RoleBinding', { exact: true }).uncheck();
  await expect(page.locator('.react-flow__node-resource').getByText('RoleBinding', { exact: true })).toHaveCount(0);
  await expect(pod).toHaveAttribute('style', position!);
  await types.getByLabel('Show RoleBinding', { exact: true }).check();
  await expect(page.locator('.react-flow__node-resource').getByText('RoleBinding', { exact: true })).toBeVisible();
  await expect(pod).toHaveAttribute('style', position!); expect(workers.length).toBe(workerCount);
  await types.getByLabel('Show Namespace', { exact: true }).uncheck(); await expect(pod).toBeVisible();
  await types.getByRole('button', { name: 'Hide all', exact: true }).click(); await expect(page.getByText('All resource types are hidden. Enable a type to display it.')).toBeVisible();
  await types.getByRole('button', { name: 'Show all', exact: true }).click(); await expect(pod).toBeVisible(); await expect(pod).toHaveAttribute('style', position!);
  await captureScreenshot(page, { path: 'test-results/topology-type-filter.png' });
  await page.keyboard.press('Escape'); await expect(types).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Helm Releases' }).click(); await page.getByTestId('helm-releases').getByRole('row', { name: 'Inspect Helm release web in backend' }).click();
  await page.getByTestId('inspector-panel').getByRole('button', { name: 'Topology', exact: true }).click();
  const node = page.locator('.react-flow__node-resource').filter({ has: page.locator('[data-resource-kind="HelmRelease"]') });
  await expect(node).toBeVisible(); await expect(page.locator('.react-flow__node-resource').getByText('Deployment', { exact: true })).toBeVisible();
  await expect(page.locator('.react-flow__edge-text').getByText('manages', { exact: true })).toBeVisible();
  await node.click();
  await expect(page.getByTestId('inspector-panel').getByTestId('resource-details')).toContainText('Managed Kubernetes objects (1 loaded)');
  await page.getByTestId('inspector-panel').getByRole('button', { name: 'Open details in tab', exact: true }).click();
  await expect(page.getByRole('tab', { name: /^Helm: web/ })).toBeVisible();
  await expect(page.getByTestId('workspace-tab-panel').getByTestId('resource-details')).toContainText('Managed Kubernetes objects (1 loaded)');
});
