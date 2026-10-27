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

test('Helm supports inspection, revision documents, name/namespace filters, incremental rendering and one tab per section', async ({ page }) => {
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
  await expect(view.getByRole('row', { name: 'Inspect Helm release web in backend' })).toBeVisible();
  await view.getByRole('button', { name: 'Helm release filters', exact: true }).click();
  await page.getByRole('dialog', { name: 'Helm release filters' }).getByRole('combobox', { name: 'Helm release status' }).selectOption('problems');
  await page.getByRole('dialog', { name: 'Helm release filters' }).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(view.getByRole('row', { name: 'Inspect Helm release web in backend' })).toHaveCount(0);
  await expect(view.getByRole('row', { name: 'Inspect Helm release broken in other' })).toBeVisible();
  await view.getByRole('button', { name: 'Helm release filters', exact: true }).click();
  await page.getByRole('dialog', { name: 'Helm release filters' }).getByRole('combobox', { name: 'Helm release status' }).selectOption('all');
  await page.getByRole('dialog', { name: 'Helm release filters' }).getByRole('button', { name: 'Done', exact: true }).click();
  const search = view.getByRole('textbox', { name: 'Search Helm releases by name or namespace' });
  await search.fill('web-chart'); await expect(view.getByText('No releases match these filters.')).toBeVisible();
  await search.fill('backend'); await expect(view.getByRole('row', { name: 'Inspect Helm release web in backend' })).toBeVisible();
  await view.getByRole('row', { name: 'Inspect Helm release web in backend' }).focus(); await page.keyboard.press('Enter');
  const details = page.getByTestId('inspector-panel').getByTestId('resource-details');
  await expect(details.getByText('Latest release snapshot')).toBeVisible();
  await details.getByRole('tab', { name: 'History', exact: true }).click();
  await details.getByRole('button', { name: 'Inspect Helm revision 1', exact: true }).click();
  await expect(details.getByLabel('Helm values revision 1')).toHaveText('values: revision-1\n');
  await details.getByRole('tab', { name: 'Manifest', exact: true }).click();
  await expect(details.getByLabel('Helm manifest revision 1')).toContainText('revision-1');
  await details.getByRole('button', { name: 'Latest revision', exact: true }).click();
  await expect(details.getByLabel('Helm manifest revision 2')).toContainText('revision-2');
  await details.getByRole('tab', { name: 'Notes', exact: true }).click();
  await expect(details.getByLabel('Helm notes revision 2')).toContainText('revision-2');
  await details.getByRole('button', { name: 'Close details' }).click();
  await expect(view.getByRole('row', { name: 'Inspect Helm release web in backend' })).toBeFocused();
  await search.fill('zz-next-page');
  await expect(view.getByRole('row', { name: 'Inspect Helm release zz-next-page in backend' })).toBeVisible();
  await expect(view).toContainText('1 of 1 matching · 101 total');
  await search.fill('');
  await view.locator('.helm-table-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(view.getByRole('row', { name: 'Inspect Helm release zz-next-page in backend' })).toBeVisible();
  await expect(view).toContainText('1–101 of 101 matching · 101 total');
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
  fail = true; await view.getByRole('button', { name: 'Refresh Helm releases' }).click();
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
  const document = page.getByTestId('inspector-panel').getByLabel('Helm values revision 2'); await expect(document).toBeVisible();
  await page.setViewportSize({ width: 900, height: 900 });
  expect(await view.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await document.evaluate(el => el.clientHeight < el.closest('[role=tabpanel]')!.clientHeight && el.scrollHeight > el.clientHeight)).toBe(true);
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
  await expect(page.getByTestId('inspector-panel').getByLabel('Helm values revision 3')).toContainText('native revision 3');
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
  await expect(details.getByLabel('Helm values revision 2')).toHaveText('replicas: 0\n');
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
  await expect(page.getByTestId('workspace-tab-panel').getByTestId('resource-details')).toBeVisible();
  expect(errors).toEqual([]);
});
