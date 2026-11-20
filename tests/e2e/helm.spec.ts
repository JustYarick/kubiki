import { captureScreenshot } from './helpers/screenshots';
import { test, expect, type Page } from '@playwright/test';
import { namespaceList } from './helpers/namespaces';

const release = (name = 'web', namespace = 'backend', status = 'deployed') => ({ name, namespace, status, revision: '2', updated: '2026-10-20 12:00:00.123456 +0000 UTC', chart: 'web-chart-1.0', app_version: '1.0' });
async function baseApi(page: Page) {
  await page.route('**/api/k8s/**', route => {
    const url = new URL(route.request().url());
    const op = url.pathname.split('/').pop();
    if (op === 'contexts') return route.fulfill({ json: [{ name: 'prod', is_current: true }, { name: 'stage', is_current: false }] });
    if (op === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (op === 'namespaces') return route.fulfill({ json: ['backend', 'other'] });
    if (url.searchParams.get('kind') === 'Namespace') return route.fulfill({ json: namespaceList(['backend', 'other']) });
    return route.fulfill({ json: { items: [] } });
  });
}
async function namespace(page: Page, name: string) {
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
  await page.getByRole('button', { name: 'Apply namespaces', exact: true }).click();
}
async function open(page: Page, section = 'Releases') {
  if (!(await page.getByTestId('explorer-panel').isVisible())) await page.getByRole('button', { name: 'Toggle Explorer', exact: true }).click();
  await page.getByRole('button', { name: `Open Helm ${section}`, exact: true }).click();
}

test('failed release shows the Helm error and events from hook Job Pods', async ({ page }) => {
  await baseApi(page);
  const namespaces: string[] = [];
  await page.route('**/api/k8s/resources?**', route => {
    const url = new URL(route.request().url());
    const kind = url.searchParams.get('kind');
    if (kind === 'Job') return route.fulfill({ json: { items: [{ apiVersion: 'batch/v1', kind: 'Job', metadata: { uid: 'hook', name: 'web-migrate', namespace: 'backend' }, status: { failed: 1 } }] } });
    if (kind === 'Pod') return route.fulfill({ json: { items: [{ apiVersion: 'v1', kind: 'Pod', metadata: { uid: 'hook-pod', name: 'web-migrate-pod', namespace: 'backend', ownerReferences: [{ uid: 'hook', kind: 'Job', name: 'web-migrate', apiVersion: 'batch/v1' }] }, status: { phase: 'Failed' } }] } });
    if (kind === 'Event') {
      namespaces.push(url.searchParams.get('namespace') ?? 'all');
      return route.fulfill({ json: { items: [{ apiVersion: 'v1', kind: 'Event', metadata: { uid: 'event', name: 'migration-failed', namespace: 'backend' }, type: 'Warning', reason: 'Failed', message: 'Migration database connection refused', involvedObject: { apiVersion: 'v1', kind: 'Pod', uid: 'hook-pod', name: 'web-migrate-pod', namespace: 'backend' } }] } });
    }
    return route.fallback();
  });
  await page.route('**/api/k8s/helm/**', route => {
    const url = new URL(route.request().url()); const op = url.pathname.split('/').pop();
    if (op === 'inventory') return route.fulfill({ json: [release('web', 'backend', 'failed')] });
    if (op === 'history') return route.fulfill({ json: [{ revision: 2, updated: '2026-10-20T12:00:00Z', status: 'failed', chart: 'web-chart-1.0', app_version: '1', description: 'UPGRADE FAILED: post-upgrade hooks failed: job failed: BackoffLimitExceeded' }] });
    if (op === 'content') return route.fulfill({ json: url.searchParams.get('document') === 'hooks' ? 'apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: web-migrate\n  namespace: backend\n' : '' });
    return route.fulfill({ json: [] });
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await open(page);
  await page.getByRole('row', { name: 'Inspect Helm release web in backend' }).click();
  const details = page.getByTestId('inspector-panel').getByTestId('resource-details');
  await expect(details.getByRole('alert')).toContainText('BackoffLimitExceeded');
  const events = details.getByRole('region', { name: 'Release events (1)', exact: true });
  await expect(events).toContainText('Migration database connection refused');
  await expect(events).toContainText('web-migrate-pod');
  await events.getByRole('button', { name: 'Refresh release events', exact: true }).click();
  await expect.poll(() => namespaces.filter(namespace => namespace === 'backend').length).toBeGreaterThan(1);
});

test('Helm supports inspection, revision documents, name/namespace filters, the shared typed table and a separate overview and one tab per section', async ({ page }) => {
  await baseApi(page);
  const calls: URL[] = [];
  await page.route('**/api/k8s/helm/**', route => {
    const url = new URL(route.request().url()); calls.push(url);
    const op = url.pathname.split('/').pop();
    if (op === 'inventory') return route.fulfill({ json: [release(), release('broken', 'other', 'failed'), ...Array.from({ length: 98 }, (_, i) => release(`a-filler-${i}`, 'backend')), release('zz-next-page')] });
    if (op === 'history') return route.fulfill({ json: [1, 2].map(revision => ({ revision, updated: 'today', status: revision === 2 ? 'deployed' : 'superseded', chart: 'web-chart-1.0', app_version: '1', description: 'Upgrade complete' })) });
    if (op === 'content') return route.fulfill({ json: `${url.searchParams.get('document')}: revision-${url.searchParams.get('revision')}\n` });
    return route.fulfill({ json: [{ name: 'stable', url: 'https://example.com/charts' }] });
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await open(page);
  const view = page.getByTestId('helm-releases');
  await view.getByRole('columnheader', { name: 'Status', exact: true }).click({ button: 'right' });
  const filter = page.getByRole('dialog', { name: 'Filter by Status', exact: true });
  await filter.getByRole('button', { name: 'failed', exact: true }).click();
  await filter.getByRole('button', { name: 'Close filter', exact: true }).click();
  await expect(view.getByRole('row', { name: 'Inspect Helm release web in backend' })).toHaveCount(0);
  await expect(view.getByRole('row', { name: 'Inspect Helm release broken in other' })).toBeVisible();
  await view.getByRole('button', { name: 'Reset all filters and sorting', exact: true }).click();
  const search = view.getByRole('textbox', { name: 'Filter helmreleases…' });
  await search.fill('web-chart'); await expect(view.getByText('No helmreleases match your filters', { exact: true })).toBeVisible();
  await search.fill('web'); await expect(view.getByRole('row', { name: 'Inspect Helm release web in backend' })).toBeVisible();
  await view.getByRole('row', { name: 'Inspect Helm release web in backend' }).focus(); await page.keyboard.press('Enter');
  const details = page.getByTestId('inspector-panel').getByTestId('resource-details');
  await expect(details.getByText('Latest release snapshot')).toBeVisible();
  await details.getByRole('tab', { name: 'History', exact: true }).click();
  await details.getByRole('button', { name: 'Inspect Helm revision 1', exact: true }).click();
  await expect(details.getByRole('group', { name: 'Helm values revision 1 editor', exact: true }).locator('.view-lines')).toContainText('values: revision-1');
  await details.getByRole('tab', { name: 'Manifest', exact: true }).click();
  await expect(details.getByRole('group', { name: 'Helm manifest revision 1 editor', exact: true }).locator('.view-lines')).toContainText('revision-1');
  await details.getByRole('button', { name: 'Latest revision', exact: true }).click();
  await expect(details.getByRole('group', { name: 'Helm manifest revision 2 editor', exact: true }).locator('.view-lines')).toContainText('revision-2');
  await details.getByRole('tab', { name: 'Notes', exact: true }).click();
  await expect(details.getByRole('group', { name: 'Helm notes revision 2 editor', exact: true }).locator('.view-lines')).toContainText('revision-2');
  await details.getByRole('button', { name: 'Close details' }).click();
  await expect(view.getByRole('row', { name: 'Inspect Helm release web in backend' })).toBeFocused();
  await search.fill('zz-next-page');
  await expect(view.getByRole('row', { name: 'Inspect Helm release zz-next-page in backend' })).toBeVisible();
  await expect(view.getByRole('row', { name: /^Inspect Helm release/ })).toHaveCount(1);
  await search.fill('');
  await expect(view.locator('table')).toHaveAttribute('aria-rowcount', '102');
  await expect.poll(() => view.getByTestId('resource-table').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await view.getByTestId('resource-table').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(view.getByRole('row', { name: 'Inspect Helm release zz-next-page in backend' })).toBeVisible();
  await open(page, 'Overview');
  const overview = page.getByTestId('helm-overview');
  await expect(overview.getByRole('region', { name: 'Helm summary', exact: true })).toBeVisible();
  await expect(overview.getByRole('region', { name: 'Helm release status', exact: true })).toBeVisible();
  await expect(overview.getByTestId('resource-table')).toHaveCount(0);
  await overview.getByRole('button', { name: 'View releases', exact: true }).click();
  await expect(view.getByTestId('resource-table')).toBeVisible();
  await open(page, 'Repositories'); await expect(page.getByTestId('helm-repositories')).toContainText('https://example.com/charts');
  await open(page); await expect(page.getByRole('tab', { name: /^Helm Releases/ })).toHaveCount(1);
  expect(calls.filter(url => ['history', 'content'].includes(url.pathname.split('/').pop()!)).every(url => url.searchParams.get('context') === 'prod' && url.searchParams.get('namespace') === 'backend' && url.searchParams.get('name') === 'web')).toBe(true);
});

test('Helm cancels late scope responses, isolates contexts and retains same-scope snapshots on refresh errors', async ({ page }) => {
  await baseApi(page);
  let fail = false; let releaseOld!: () => void;
  const oldResponse = new Promise<void>(resolve => { releaseOld = resolve; });
  let held = false;
  await page.route('**/api/k8s/helm/inventory**', async route => {
    const url = new URL(route.request().url()); const ns = url.searchParams.get('namespace'); const context = url.searchParams.get('context');
    if (ns === 'backend') { held = true; await oldResponse; }
    if (fail) return route.fulfill({ status: 403, json: { error: { code: 'forbidden', status: 403, message: 'Helm release secrets are forbidden', retryable: false } } });
    return route.fulfill({ json: [release(`${context}-${ns ?? 'all'}`, ns ?? 'backend')] });
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await open(page);
  const view = page.getByTestId('helm-releases');
  await expect(view.getByRole('row', { name: 'Inspect Helm release prod-all in backend' })).toBeVisible();
  await namespace(page, 'backend'); await expect.poll(() => held).toBe(true);
  await namespace(page, 'other'); await expect(view.getByRole('row', { name: 'Inspect Helm release prod-other in other' })).toBeVisible();
  releaseOld(); await expect(view.getByText('prod-backend', { exact: true })).toHaveCount(0);
  fail = true; await view.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(view.getByRole('alert')).toContainText('may be out of date');
  await expect(view.getByRole('row', { name: 'Inspect Helm release prod-other in other' })).toBeVisible();
  fail = false; await view.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(view.getByRole('alert')).toHaveCount(0);
  await page.getByTitle('Switch Kubernetes Cluster Context', { exact: true }).click();
  await page.getByText('stage', { exact: true }).click();
  await expect(view.getByRole('row', { name: 'Inspect Helm release stage-all in backend' })).toBeVisible();
  await expect(view.getByText('prod-other', { exact: true })).toHaveCount(0);
});

test('Helm missing binary offers retry, repositories have a real empty state, and narrow detail panels stay bounded', async ({ page }) => {
  await baseApi(page); let missing = true;
  await page.route('**/api/k8s/helm/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/repositories')) return route.fulfill({ json: [] });
    if (url.pathname.endsWith('/content')) return route.fulfill({ json: 'key: ' + 'x'.repeat(10000) + '\n' + 'line\n'.repeat(2000) });
    if (missing) return route.fulfill({ status: 503, json: { error: { code: 'bridge_unavailable', status: 503, message: 'Helm is not installed or is not available in PATH.', retryable: true } } });
    return route.fulfill({ json: [release('wide-release-name-for-responsive-details')] });
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await open(page); const view = page.getByTestId('helm-releases');
  await expect(view.getByRole('alert')).toContainText('Helm is not installed');
  await expect(view.getByText(/No Helm releases/)).toHaveCount(0);
  missing = false; await view.getByRole('button', { name: 'Retry', exact: true }).click();
  await view.getByRole('row', { name: /Inspect Helm release wide/ }).click();
  await page.getByTestId('inspector-panel').getByRole('tab', { name: 'Values', exact: true }).click();
  const document = page.getByTestId('inspector-panel').getByRole('group', { name: 'Helm values revision 2 editor', exact: true }); await expect(document.locator('.monaco-editor')).toBeVisible();
  await page.setViewportSize({ width: 900, height: 900 });
  expect(await view.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(document.locator('.monaco-scrollable-element').first()).toBeVisible();
  expect(await document.evaluate(el => el.clientHeight < el.closest('[role=tabpanel]')!.clientHeight && el.scrollWidth <= el.clientWidth)).toBe(true);
  const scroll = document.locator('.monaco-scrollable-element').first();
  expect(await scroll.evaluate(el => el.querySelector('.view-lines')!.clientHeight > el.clientHeight)).toBe(true);
  await captureScreenshot(page, { path: 'test-results/helm-narrow.png' });
  await open(page, 'Repositories'); await expect(page.getByTestId('helm-repositories')).toContainText('No repositories configured');
});

test('desktop Helm goes through explicit read IPC commands', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: Array<{ command: string; args: any }> = [];
    (window as any).__helmCalls = calls;
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        calls.push({ command, args });
        if (command === 'get_kube_contexts') return [{ name: 'native-prod', is_current: true }];
        if (command === 'ping_cluster') return { git_version: 'v1.35.0' };
        if (command === 'get_namespaces') return ['backend'];
        if (command === 'get_resources') return { items: [] };
        if (command === 'get_helm_inventory') return [{ name: 'native-web', namespace: 'backend', revision: '3', updated: '', status: 'deployed', chart: 'web-1', app_version: '1' }];
        if (command === 'get_helm_content') return `native revision ${args.revision}`;
        if (command === 'list_helm_repositories' || command === 'get_helm_history') return [];
        if (command.startsWith('stop_') || command === 'watch_resources' || command === 'ack_resources') return;
        throw new Error(`Unexpected command: ${command}`);
      },
    };
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await open(page);
  const view = page.getByTestId('helm-releases');
  await view.getByRole('row', { name: 'Inspect Helm release native-web in backend' }).click();
  await page.getByTestId('inspector-panel').getByRole('tab', { name: 'Values', exact: true }).click();
  await expect(page.getByTestId('inspector-panel').getByRole('group', { name: 'Helm values revision 3 editor', exact: true }).locator('.view-lines')).toContainText('native revision 3');
  const calls = await page.evaluate(() => (window as any).__helmCalls.filter((call: any) => call.command.includes('helm')));
  expect(calls).toEqual(expect.arrayContaining([expect.objectContaining({ command: 'get_helm_inventory', args: expect.objectContaining({ context: 'native-prod', namespace: null }) }), expect.objectContaining({ command: 'get_helm_content', args: expect.objectContaining({ context: 'native-prod', namespace: 'backend', name: 'native-web', revision: 3, document: 'values' }) })]));
  expect(calls.every((call: any) => ['get_helm_inventory', 'get_helm_content', 'get_helm_history', 'list_helm_repositories'].includes(call.command))).toBe(true);
});

test('Helm reuses the resource inspector, navigation, resizing, tabs and split details', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await baseApi(page);
  await page.route('**/api/k8s/resources?**', route => {
    const kind = new URL(route.request().url()).searchParams.get('kind');
    return route.fulfill({ json: { items: kind === 'Deployment' ? [{ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'owned-web', namespace: 'backend', uid: 'owned-web', labels: { 'app.kubernetes.io/managed-by': 'Helm' }, annotations: { 'meta.helm.sh/release-name': 'web', 'meta.helm.sh/release-namespace': 'backend' } }, spec: { replicas: 0 } }] : [] } });
  });
  await page.route('**/api/k8s/helm/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/history')) return route.fulfill({ json: [{ revision: 2, updated: '', status: 'deployed', chart: 'web-chart-1.0', app_version: '1', description: '' }] });
    if (url.pathname.endsWith('/content')) return route.fulfill({ json: 'replicas: 0\n' });
    return route.fulfill({ json: [release()] });
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await open(page);
  const list = page.getByTestId('helm-releases');
  await list.getByRole('row', { name: 'Inspect Helm release web in backend' }).click();
  const panel = page.getByTestId('inspector-panel');
  const details = panel.getByTestId('resource-details');
  await expect(details.getByRole('tablist', { name: 'Resource details', exact: true })).toBeVisible();
  await expect(list.getByTestId('resource-details')).toHaveCount(0);
  await expect(page.locator('.helm-details')).toHaveCount(0);
  const width = (await panel.boundingBox())!.width;
  const resize = page.getByRole('separator', { name: 'Resize panels', exact: true }).last();
  await resize.focus(); await resize.press('Shift+ArrowRight'); await resize.press('Shift+ArrowRight');
  expect((await panel.boundingBox())!.width).toBeLessThan(width);
  await details.getByRole('button', { name: 'Keep details on Overview', exact: true }).click();
  await expect(details.getByRole('button', { name: 'Keep details on Overview', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await details.getByRole('button', { name: /Inspect Deployment owned-web in backend/ }).click();
  await expect(details.getByText('Deployment · backend', { exact: true })).toBeVisible();
  await details.getByRole('button', { name: 'Back to previous resource', exact: true }).click();
  await expect(details.getByText('HelmRelease · backend', { exact: true })).toBeVisible();
  const history = details.getByRole('tab', { name: 'History', exact: true });
  await history.focus(); await history.press('ArrowRight');
  await expect(details.getByRole('tab', { name: 'Values', exact: true })).toBeFocused();
  await expect(details.getByRole('group', { name: 'Helm values revision 2 editor', exact: true }).locator('.view-lines')).toContainText('replicas: 0');
  await details.getByRole('tab', { name: 'Overview', exact: true }).click();
  await details.getByRole('button', { name: 'Open details in tab', exact: true }).click();
  const workspace = page.getByTestId('workspace-tab-panel');
  await expect(workspace.getByTestId('resource-details').getByText('HelmRelease · backend', { exact: true })).toBeVisible();
  // Close the list so the normal split command pairs the two resource details tabs.
  await page.getByRole('tab', { name: /^Helm Releases/ }).getByRole('button', { name: 'Close tab', exact: true }).click();
  await workspace.getByTestId('resource-details').getByRole('button', { name: /Inspect Deployment owned-web in backend/ }).click();
  await page.getByRole('button', { name: 'Split Editor', exact: true }).click();
  await expect(workspace.getByTestId('resource-details')).toHaveCount(2);
  await expect(workspace.getByRole('tablist', { name: 'Resource details', exact: true })).toHaveCount(2);
  await captureScreenshot(page, { path: 'test-results/helm-shared-details.png' });
  await page.reload();
  await expect(page.getByTestId('workspace-tab-panel').getByTestId('resource-details')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('Helm Overview summarizes healthy releases with shared overview icons and scoped navigation', async ({ page }) => {
  await baseApi(page);
  await page.route('**/api/k8s/helm/inventory**', route => route.fulfill({ json: [
    { ...release('api', 'backend'), chart: 'api-1.0.0' },
    { ...release('worker', 'backend'), chart: 'api-1.0.0', updated: '2026-11-17T12:00:00Z' },
    { ...release('database', 'other'), chart: 'postgres-16.0.0' },
  ] }));
  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  const navigation = page.getByRole('button', { name: 'Open Helm Overview', exact: true });
  await expect(navigation.locator('svg')).toHaveClass(/lucide-layout-dashboard/);
  await navigation.click();
  const overview = page.getByTestId('helm-overview');
  await expect(page.getByRole('tab', { name: /^Helm Overview/ }).locator('svg').first()).toHaveClass(/lucide-layout-dashboard/);
  await expect(overview.getByRole('button', { name: 'Releases: 3', exact: true })).toBeVisible();
  await expect(overview.getByRole('button', { name: 'Deployed: 3', exact: true })).toBeVisible();
  await expect(overview.getByRole('region', { name: 'Helm summary', exact: true })).toContainText('Namespaces with releases');
  await expect(overview.getByRole('region', { name: 'Helm release status', exact: true }).getByRole('img')).toHaveAccessibleName(/3 deployed/);
  await expect(overview.getByRole('region', { name: 'Helm charts', exact: true })).toContainText('2 installed chart versions');
  await expect(overview.getByRole('region', { name: 'Helm recent updates', exact: true }).getByRole('button', { name: /^Inspect / }).first()).toContainText('worker');
  await expect(overview.getByText('Releases needing attention', { exact: true })).toHaveCount(0);
  await expect(overview.getByText('No failed or pending Helm operations in the loaded inventory.', { exact: true })).toHaveCount(0);
  await captureScreenshot(page, { path: 'test-results/helm-overview-desktop.png' });
  await page.setViewportSize({ width: 800, height: 800 });
  expect(await overview.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await overview.getByRole('region', { name: 'Helm namespaces', exact: true }).getByRole('button', { name: 'backend: 2 releases, 0 failed, 0 in progress', exact: true }).click();
  const table = page.getByTestId('helm-releases');
  await expect(table.getByRole('row', { name: 'Inspect Helm release api in backend', exact: true })).toBeVisible();
  await expect(table.getByRole('row', { name: 'Inspect Helm release database in other', exact: true })).toHaveCount(0);
});

test('Helm Overview keeps cluster-wide counts with a namespace selected, distinguishes statuses and opens matching releases', async ({ page }) => {
  await baseApi(page);
  const calls: URL[] = [];
  let fail = false;
  const now = Date.now();
  const releases = [
    { ...release('api', 'backend'), updated: new Date(now - 3600000).toISOString() },
    { ...release('database', 'other', 'failed'), chart: 'postgres-16.0.0', updated: new Date(now - 7200000).toISOString() },
    { ...release('worker', 'other', 'pending-upgrade'), updated: new Date(now - 90000000).toISOString() },
    { ...release('legacy', 'other', 'uninstalled'), updated: 'unknown' },
  ];
  await page.route('**/api/k8s/helm/inventory**', route => {
    const url = new URL(route.request().url()); calls.push(url);
    if (fail) return route.fulfill({ status: 503, json: { error: { code: 'bridge_unavailable', message: 'Inventory temporarily unavailable', retryable: true } } });
    const ns = url.searchParams.get('namespace');
    return route.fulfill({ json: releases.filter(release => !ns || release.namespace === ns) });
  });
  await page.goto('/');
  await namespace(page, 'backend');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await open(page, 'Overview');
  const overview = page.getByTestId('helm-overview');
  await expect(overview.getByRole('button', { name: 'Releases: 4', exact: true })).toBeVisible();
  await expect(overview.getByText('All namespaces', { exact: true })).toBeVisible();
  await expect(overview.getByRole('button', { name: 'Deployed: 1', exact: true })).toContainText('25%');
  await expect(overview.getByRole('button', { name: 'In progress: 1', exact: true })).toBeVisible();
  await expect(overview.getByRole('button', { name: 'Failed: 1', exact: true })).toBeVisible();
  await expect(overview.locator('.helm-inventory-facts > div').filter({ hasText: 'Releases updated in 24h' })).toContainText('2');
  await expect(overview.getByRole('region', { name: 'Helm release status', exact: true }).getByRole('img')).toHaveAccessibleName(/1 other/);
  await expect(overview.getByRole('region', { name: 'Helm namespaces', exact: true }).getByRole('button').first()).toHaveAccessibleName('other: 3 releases, 1 failed, 1 in progress');
  expect(calls.some(url => !url.searchParams.has('namespace'))).toBe(true);
  await captureScreenshot(page, { path: 'test-results/helm-overview-mixed.png' });
  await overview.getByRole('button', { name: 'Failed: 1', exact: true }).click();
  const table = page.getByTestId('helm-releases');
  await expect(table.getByRole('row', { name: 'Inspect Helm release database in other', exact: true })).toBeVisible();
  await expect(table.getByRole('row', { name: /^Inspect Helm release/ })).toHaveCount(1);
  await open(page, 'Overview');
  fail = true;
  await overview.getByRole('button', { name: 'Refresh Helm releases', exact: true }).click();
  await expect(overview.getByRole('status')).toContainText('Last available snapshot');
  await expect(overview.getByRole('button', { name: 'Releases: 4', exact: true })).toBeVisible();
  await expect(overview.getByRole('alert')).toContainText('may be out of date');
});

test('Helm Overview distinguishes unavailable, empty and partial cluster inventory', async ({ page }) => {
  await baseApi(page);
  let mode = 'unavailable';
  await page.route('**/api/k8s/helm/inventory**', route => {
    const ns = new URL(route.request().url()).searchParams.get('namespace');
    if (mode === 'unavailable') return route.fulfill({ status: 503, json: { error: { code: 'bridge_unavailable', message: 'Inventory unavailable', retryable: true } } });
    if (mode === 'partial' && ns !== 'backend') return route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'Release read forbidden', retryable: false } } });
    return route.fulfill({ json: [] });
  });
  await page.goto('/');
  await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click();
  await open(page, 'Overview');
  const overview = page.getByTestId('helm-overview');
  await expect(overview.getByRole('heading', { name: 'Helm inventory unavailable', exact: true })).toBeVisible();
  await expect(overview.getByRole('button', { name: 'Releases: —', exact: true })).toBeVisible();
  mode = 'empty';
  await overview.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(overview.getByRole('heading', { name: 'No Helm releases yet', exact: true })).toBeVisible();
  await expect(overview.getByRole('button', { name: 'Releases: 0', exact: true })).toBeVisible();
  mode = 'partial';
  await overview.getByRole('button', { name: 'Refresh Helm releases', exact: true }).click();
  await expect(overview.getByRole('status')).toContainText('Partial inventory');
  await expect(overview.getByRole('heading', { name: 'No releases in accessible namespaces', exact: true })).toBeVisible();
  await expect(overview.getByText('No Helm releases yet', { exact: true })).toHaveCount(0);
});
