import { test, expect, type Page } from '@playwright/test';

const release = (name = 'web', namespace = 'backend', status = 'deployed') => ({ name, namespace, status, revision: '2', updated: '2026-10-20 12:00:00.123456 +0000 UTC', chart: 'web-chart-1.0', app_version: '1.0' });
async function baseApi(page: Page) {
  await page.route('**/api/k8s/**', route => {
    const op = new URL(route.request().url()).pathname.split('/').pop();
    if (op === 'contexts') return route.fulfill({ json: [{ name: 'prod', is_current: true }, { name: 'stage', is_current: false }] });
    if (op === 'ping') return route.fulfill({ json: { version: { gitVersion: 'v1.35.0' } } });
    if (op === 'namespaces') return route.fulfill({ json: ['backend', 'other'] });
    return route.fulfill({ json: { items: [] } });
  });
}
async function namespace(page: Page, name: string) {
  await page.getByRole('button', { name: 'Namespace Scope', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}
async function open(page: Page, section = 'Releases') {
  await page.getByRole('button', { name: `Open Helm ${section}`, exact: true }).click();
}

test('Helm supports inspection, revision documents, name/namespace filters, pagination and one tab per section', async ({ page }) => {
  await baseApi(page);
  const calls: URL[] = [];
  await page.route('**/api/k8s/helm/**', route => {
    const url = new URL(route.request().url()); calls.push(url);
    const op = url.pathname.split('/').pop();
    if (op === 'releases') return route.fulfill({ json: { context: url.searchParams.get('context'), namespace: url.searchParams.get('namespace'), offset: Number(url.searchParams.get('offset')), limit: 100, has_more: url.searchParams.get('offset') === '0', items: url.searchParams.get('offset') === '0' ? [release(), release('broken', 'other', 'failed')] : [release('next-page')] } });
    if (op === 'history') return route.fulfill({ json: [1, 2].map(revision => ({ revision, updated: 'today', status: revision === 2 ? 'deployed' : 'superseded', chart: 'web-chart-1.0', app_version: '1', description: 'Upgrade complete' })) });
    if (op === 'content') return route.fulfill({ json: `${url.searchParams.get('document')}: revision-${url.searchParams.get('revision')}\n` });
    return route.fulfill({ json: [{ name: 'stable', url: 'https://example.com/charts' }] });
  });
  await page.goto('/'); await open(page);
  const view = page.getByTestId('helm-releases');
  await expect(view.getByRole('row', { name: 'Inspect Helm release web in backend' })).toBeVisible();
  await view.getByRole('combobox', { name: 'Helm release status' }).selectOption('problems');
  await expect(view.getByRole('row', { name: 'Inspect Helm release web in backend' })).toHaveCount(0);
  await expect(view.getByRole('row', { name: 'Inspect Helm release broken in other' })).toBeVisible();
  await view.getByRole('combobox', { name: 'Helm release status' }).selectOption('all');
  const search = view.getByRole('textbox', { name: 'Search Helm releases by name or namespace' });
  await search.fill('web-chart'); await expect(view.getByText('No releases match the filters on this page.')).toBeVisible();
  await search.fill('backend'); await expect(view.getByRole('row', { name: 'Inspect Helm release web in backend' })).toBeVisible();
  await view.getByRole('row', { name: 'Inspect Helm release web in backend' }).focus(); await page.keyboard.press('Enter');
  const details = view.getByRole('complementary', { name: 'Helm release details web' });
  await expect(details.getByText('Latest release snapshot')).toBeVisible();
  await details.getByRole('button', { name: 'History', exact: true }).click();
  await details.getByRole('row', { name: 'Inspect Helm revision 1' }).click();
  await expect(details.getByLabel('Helm values revision 1')).toHaveText('values: revision-1\n');
  await details.getByRole('button', { name: 'Manifest', exact: true }).click();
  await expect(details.getByLabel('Helm manifest revision 1')).toContainText('revision-1');
  await details.getByRole('button', { name: 'Latest revision', exact: true }).click();
  await expect(details.getByLabel('Helm manifest revision 2')).toContainText('revision-2');
  await details.getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(details.getByLabel('Helm notes revision 2')).toContainText('revision-2');
  await details.getByRole('button', { name: 'Close Helm details' }).click();
  await expect(view.getByRole('row', { name: 'Inspect Helm release web in backend' })).toBeFocused();
  await search.fill(''); await view.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(view.getByRole('row', { name: 'Inspect Helm release next-page in backend' })).toBeVisible();
  await expect(view.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
  await open(page, 'Repositories'); await expect(page.getByTestId('helm-repositories')).toContainText('https://example.com/charts');
  await open(page); await expect(page.getByRole('tab', { name: /^Helm Releases/ })).toHaveCount(1);
  expect(calls.filter(url => ['history', 'content'].includes(url.pathname.split('/').pop()!)).every(url => url.searchParams.get('context') === 'prod' && url.searchParams.get('namespace') === 'backend' && url.searchParams.get('name') === 'web')).toBe(true);
});

test('Helm cancels late scope responses, isolates contexts and retains same-scope snapshots on refresh errors', async ({ page }) => {
  await baseApi(page);
  let fail = false; let releaseOld!: () => void;
  const oldResponse = new Promise<void>(resolve => { releaseOld = resolve; });
  let held = false;
  await page.route('**/api/k8s/helm/releases**', async route => {
    const url = new URL(route.request().url()); const ns = url.searchParams.get('namespace'); const context = url.searchParams.get('context');
    if (ns === 'backend') { held = true; await oldResponse; }
    if (fail) return route.fulfill({ status: 403, json: { error: { code: 'forbidden', status: 403, message: 'Helm release secrets are forbidden', retryable: false } } });
    return route.fulfill({ json: { context, namespace: ns, offset: 0, limit: 100, has_more: false, items: [release(`${context}-${ns ?? 'all'}`, ns ?? 'backend')] } });
  });
  await page.goto('/'); await open(page);
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
    return route.fulfill({ json: { context: 'prod', namespace: null, offset: 0, limit: 100, has_more: false, items: [release('wide-release-name-for-responsive-details')] } });
  });
  await page.goto('/'); await open(page); const view = page.getByTestId('helm-releases');
  await expect(view.getByRole('alert')).toContainText('Helm is not installed');
  await expect(view.getByText(/No Helm releases/)).toHaveCount(0);
  missing = false; await view.getByRole('button', { name: 'Retry', exact: true }).click();
  await view.getByRole('row', { name: /Inspect Helm release wide/ }).click();
  await view.getByRole('button', { name: 'Values', exact: true }).click();
  const document = view.getByLabel('Helm values revision 2'); await expect(document).toBeVisible();
  await page.setViewportSize({ width: 900, height: 900 });
  expect(await view.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await document.evaluate(el => el.clientHeight < 500 && el.scrollHeight > el.clientHeight)).toBe(true);
  await page.screenshot({ path: 'test-results/helm-narrow.png' });
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
        if (command === 'list_helm_releases') return { ...args, limit: 100, has_more: false, items: [{ name: 'native-web', namespace: 'backend', revision: '3', updated: '', status: 'deployed', chart: 'web-1', app_version: '1' }] };
        if (command === 'get_helm_content') return `native revision ${args.revision}`;
        if (command === 'list_helm_repositories' || command === 'get_helm_history') return [];
        if (command.startsWith('stop_') || command === 'watch_resources' || command === 'ack_resources') return;
        throw new Error(`Unexpected command: ${command}`);
      },
    };
  });
  await page.goto('/'); await open(page);
  const view = page.getByTestId('helm-releases');
  await view.getByRole('row', { name: 'Inspect Helm release native-web in backend' }).click();
  await view.getByRole('button', { name: 'Values', exact: true }).click();
  await expect(view.getByLabel('Helm values revision 3')).toContainText('native revision 3');
  const calls = await page.evaluate(() => (window as any).__helmCalls.filter((call: any) => call.command.includes('helm')));
  expect(calls).toEqual(expect.arrayContaining([{ command: 'list_helm_releases', args: { context: 'native-prod', namespace: null, offset: 0 } }, { command: 'get_helm_content', args: { context: 'native-prod', namespace: 'backend', name: 'native-web', revision: 3, document: 'values' } }]));
  expect(calls.every((call: any) => ['list_helm_releases', 'get_helm_content', 'get_helm_history', 'list_helm_repositories'].includes(call.command))).toBe(true);
});
