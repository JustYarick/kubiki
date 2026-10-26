import { test, expect } from '@playwright/test';
import { namespaceList } from './helpers/namespaces';

function captureReactErrors(page: import('@playwright/test').Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /Invalid hook|resolveDispatcher|Uncaught component error|useState/.test(message.text())) errors.push(message.text());
  });
  return errors;
}

test('YAML mounts a real editor repeatedly in inspector, tab and split without hook errors', async ({ page }) => {
  const errors = captureReactErrors(page);
  await page.goto('/?demo=1'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').getByText('api-gateway-7f9c8b6d5-q7x9z', { exact: true }).click();
  const inspector = page.getByTestId('resource-details');
  for (let index = 0; index < 3; index++) {
    await inspector.getByRole('tab', { name: 'YAML', exact: true }).click();
    await expect(inspector.locator('.monaco-editor')).toBeVisible({ timeout: 15000 });
    await expect(inspector.locator('.view-lines')).toContainText('api-gateway');
    await inspector.getByRole('tab', { name: 'Overview', exact: true }).click();
  }
  await page.getByTestId('resource-table').getByText('api-gateway-7f9c8b6d5-q7x9z', { exact: true }).dblclick();
  await expect(page.locator('main .monaco-editor')).toBeVisible();
  await inspector.getByRole('tab', { name: 'YAML', exact: true }).click();
  await expect(page.locator('.monaco-editor')).toHaveCount(2);
  await page.getByRole('button', { name: 'Split Editor', exact: true }).click();
  await expect(page.locator('main .monaco-editor')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('main .monaco-editor')).toBeVisible({ timeout: 15000 });
  expect(errors).toEqual([]);
});

test('Related displays distinct kind badges and preserves resource navigation', async ({ page }) => {
  await page.goto('/?demo=1'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').getByText('api-gateway-7f9c8b6d5-q7x9z', { exact: true }).click();
  const inspector = page.getByTestId('resource-details');
  await inspector.getByRole('tab', { name: /^Related/ }).click();
  await expect(inspector.locator('[data-resource-kind="ReplicaSet"]')).toBeVisible();
  await inspector.getByRole('button').filter({ has: page.locator('[data-resource-kind="ReplicaSet"]') }).click();
  await inspector.getByRole('tab', { name: /^Related/ }).click();
  const deployment = inspector.locator('[data-resource-kind="Deployment"]');
  const pod = inspector.locator('[data-resource-kind="Pod"]');
  await expect(deployment).toBeVisible();
  await expect(pod).toBeVisible();
  expect(await deployment.evaluate((element) => getComputedStyle(element).color)).not.toBe(await pod.evaluate((element) => getComputedStyle(element).color));
  await inspector.getByRole('button').filter({ has: page.locator('[data-resource-kind="Deployment"]') }).click();
  await expect(inspector.getByText('Deployment · default')).toBeVisible();
  await page.screenshot({ path: 'test-results/details-kind-badges.png' });
});

test('annotations render readable fields, a last-applied summary and expandable exact source', async ({ page }) => {
  const applied = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', namespace: 'backend' }, spec: { replicas: 0, template: { spec: { containers: [{ name: 'app', image: 'nginx:1.27' }] } } } };
  const annotations = {
    'deployment.kubernetes.io/revision': '7',
    'kubernetes.io/change-cause': 'Upgrade frontend to v2',
    'example.com/network': JSON.stringify({ network: { ip: '10.42.0.2', ready: true }, ports: [80, 443] }),
    'example.com/notes': 'first line\nsecond line',
    'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify(applied),
  };
  await page.route('**/api/k8s/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/contexts')) return route.fulfill({ json: [{ name: 'test', is_current: true }] });
    if (url.pathname.endsWith('/ping')) return route.fulfill({ json: { version: { gitVersion: 'v1.34.0' } } });
    if (url.pathname.endsWith('/namespaces')) return route.fulfill({ json: ['backend'] });
    return route.fulfill({ json: { items: url.searchParams.get('kind') === 'Pod' ? [{ apiVersion: 'v1', kind: 'Pod', metadata: { uid: 'annotated', name: 'annotated-web', namespace: 'backend', annotations }, spec: { containers: [] } }] : [] } });
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').getByText('annotated-web', { exact: true }).click();
  await page.getByTestId('resource-details').getByText('Metadata & Object Spec', { exact: true }).click();
  const card = page.getByRole('region', { name: 'Annotations (5)', exact: true });
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByText('Revision', { exact: true })).toBeVisible();
  await expect(card.getByText('Upgrade frontend to v2', { exact: true })).toBeVisible();
  const network = card.getByRole('article', { name: 'example.com/network', exact: true });
  await expect(network.getByText('network.ip', { exact: true })).toBeVisible();
  await expect(network.getByText('10.42.0.2', { exact: true })).toBeVisible();
  await expect(network.getByText('ports[1]', { exact: true })).toBeVisible();
  const lastApplied = card.getByRole('article', { name: 'kubectl.kubernetes.io/last-applied-configuration', exact: true });
  await expect(lastApplied.getByText('nginx:1.27', { exact: true }).first()).toBeVisible();
  await expect(lastApplied.locator('dd').filter({ hasText: /^0$/ }).first()).toBeVisible();
  await expect(lastApplied.getByText('spec.template.spec.containers[0].image', { exact: true })).toBeHidden();
  await lastApplied.getByText('Original value', { exact: true }).click();
  await expect(lastApplied.locator('pre')).toHaveText(JSON.stringify(applied));
  await lastApplied.getByText('Original value', { exact: true }).click();
  await lastApplied.getByText(/^Manifest fields/).click();
  await expect(lastApplied.getByText('spec.replicas', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/annotations.png' });
});

async function mockResourceLists(page: import('@playwright/test').Page, lists: Record<string, object[]>, namespaces = ['backend']) {
  await page.route('**/api/k8s/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/contexts')) return route.fulfill({ json: [{ name: 'test', is_current: true }] });
    if (url.pathname.endsWith('/ping')) return route.fulfill({ json: { version: { gitVersion: 'v1.34.0' } } });
    if (url.pathname.endsWith('/namespaces')) return route.fulfill({ json: namespaces });
    const kind = url.searchParams.get('kind') ?? '';
    return route.fulfill({ json: { items: lists[kind] ?? (kind === 'Namespace' ? namespaceList(namespaces).items : []) } });
  });
}

test('warning reasons are shared by plain table rows, Related and topology nodes', async ({ page }) => {
  await mockResourceLists(page, {
    Pod: [{ apiVersion: 'v1', kind: 'Pod', metadata: { uid: 'broken', name: 'broken-pod', namespace: 'backend' }, spec: { nodeName: 'worker', containers: [{ name: 'app' }] }, status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: false, state: { waiting: { reason: 'CrashLoopBackOff', message: 'Back-off restarting failed container app' } } }] } }, { metadata: { uid: 'healthy', name: 'healthy-pod', namespace: 'backend' }, spec: { containers: [{ name: 'app' }] }, status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, state: { running: {} } }] } }],
    Node: [{ metadata: { uid: 'worker', name: 'worker' }, status: { conditions: [{ type: 'Ready', status: 'False', reason: 'KubeletNotReady', message: 'Container runtime network is not ready' }] } }],
    Namespace: [{ metadata: { uid: 'ns', name: 'backend' }, status: { phase: 'Active' } }],
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  const row = page.getByTestId('resource-table').locator('tbody tr').filter({ hasText: 'broken-pod' });
  await expect(row.locator('button')).toHaveCount(0);
  await row.locator('[data-resource-issues]').hover();
  await expect(page.getByRole('tooltip')).toContainText('Back-off restarting failed container app');
  await expect(page.getByTestId('resource-table').locator('tbody tr').filter({ hasText: 'healthy-pod' }).locator('[data-resource-issues]')).toHaveCount(0);
  await row.click();
  const inspector = page.getByTestId('resource-details');
  await inspector.getByRole('tab', { name: /^Related/ }).click();
  const node = inspector.getByRole('button').filter({ has: page.locator('[data-resource-kind="Node"]') });
  await node.locator('[data-resource-issues]').focus();
  await expect(page.getByRole('tooltip')).toContainText('Container runtime network is not ready');
  await page.keyboard.press('Escape');
  await inspector.getByRole('button', { name: 'Topology', exact: true }).click();
  const graphPod = page.locator('.react-flow__node').filter({ hasText: 'broken-pod' });
  await expect(graphPod).toBeVisible();
  await graphPod.locator('[data-resource-issues]').hover();
  await expect(page.getByRole('tooltip')).toContainText('Back-off restarting failed container app');
  await page.screenshot({ path: 'test-results/topology-warnings.png' });
});

test('Namespace Related shows members with kind badges, filtering and a bounded first page', async ({ page }) => {
  await mockResourceLists(page, {
    Namespace: [{ metadata: { uid: 'ns', name: 'backend' } }],
    Pod: Array.from({ length: 120 }, (_, index) => ({ metadata: { uid: `pod-${index}`, name: `backend-pod-${index}`, namespace: 'backend' }, spec: { containers: [] } })),
    Service: [{ metadata: { uid: 'svc', name: 'backend-service', namespace: 'backend' }, spec: {} }],
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByRole('button', { name: /^Namespaces(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').getByText('backend', { exact: true }).click();
  const inspector = page.getByTestId('resource-details');
  await inspector.getByRole('tab', { name: /^Related/ }).click();
  await expect(inspector.getByText('121 matching · 121 relationships')).toBeVisible();
  await expect(inspector.locator('[data-resource-kind="Pod"]')).toHaveCount(50);
  await inspector.getByPlaceholder('Filter related resources…').fill('Service');
  await expect(inspector.locator('[data-resource-kind="Service"]')).toHaveCount(1);
  await expect(inspector.getByText('backend-service', { exact: true })).toBeVisible();
  await inspector.getByPlaceholder('Filter related resources…').fill('');
  await inspector.getByRole('button', { name: 'Show next 50', exact: true }).click();
  await expect(inspector.locator('[data-resource-kind="Pod"]')).toHaveCount(100);
});

test('a large cluster retains all objects and renders offscreen nodes when panned into view', async ({ page }) => {
  const layoutWorkers: string[] = [];
  page.on('worker', (worker) => { if (worker.url().includes('layout_worker')) layoutWorkers.push(worker.url()); });
  await mockResourceLists(page, {
    Pod: Array.from({ length: 300 }, (_, index) => ({ metadata: { uid: `pod-${index}`, name: `busy-pod-${index}`, namespace: 'busy' }, spec: { containers: [] } })),
    Namespace: [{ metadata: { uid: 'ns', name: 'busy' } }],
  }, ['busy']);
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByRole('button', { name: 'Cluster topology', exact: true }).click();
  await expect(page.locator('.topology-view')).toHaveAttribute('data-scope', '');
  await expect(page.getByText('Choose a diagram scope', { exact: true })).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
  expect(layoutWorkers).toEqual([]);
  await page.getByRole('button', { name: 'All Namespaces', exact: true }).click();
  await expect(page.locator('.topology-summary')).toContainText('301 resources · 0 links', { timeout: 20000 });
  const nodes = page.locator('.react-flow__node-resource');
  await expect.poll(() => nodes.count()).toBeGreaterThan(0);
  expect(await nodes.count()).toBeLessThan(300);
  const minimapNodes = page.locator('.react-flow__minimap-node');
  await expect(minimapNodes).toHaveCount(301);
  const last = nodes.filter({ hasText: 'busy-pod-299' });
  await expect(last).toHaveCount(0);
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', /scale\(0\.1\)/);
  const minimap = (await page.locator('.react-flow__minimap-svg').boundingBox())!;
  const target = (await minimapNodes.last().boundingBox())!;
  await page.mouse.move(minimap.x + minimap.width / 2, minimap.y + minimap.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(last).toBeVisible();
  await expect(minimapNodes).toHaveCount(301);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(layoutWorkers.length).toBeGreaterThan(0);
});

test('namespace selectors filter by name, support keyboard selection and keep scrolling inside the menu', async ({ page }) => {
  const namespaces = Array.from({ length: 130 }, (_, index) => `team-${String(index).padStart(3, '0')}`);
  await mockResourceLists(page, {}, namespaces);
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  const globalScope = page.getByRole('button', { name: 'Namespace Scope', exact: true });
  await globalScope.click();
  const menu = page.getByRole('dialog', { name: 'Choose Namespace Scope', exact: true });
  await expect(menu.getByRole('option')).toHaveCount(50);
  const list = menu.getByRole('listbox');
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: 'Show next 50', exact: true }).click();
  await expect(menu.getByRole('option')).toHaveCount(100);
  const search = menu.getByRole('searchbox', { name: 'Filter Namespace Scope by name', exact: true });
  await search.fill('TEAM-129');
  await expect(menu.getByRole('option')).toHaveCount(1);
  await search.press('ArrowDown');
  await expect(menu.getByRole('option', { name: 'team-129', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await menu.getByRole('button', { name: 'Apply namespaces', exact: true }).click();
  await expect(globalScope).toHaveAttribute('data-value', 'team-129');
  await globalScope.click();
  await menu.getByRole('searchbox').fill('does-not-exist');
  await expect(menu.getByText('No matching namespaces.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await globalScope.click();
  await expect(menu.getByRole('searchbox')).toHaveValue('');
  await menu.getByRole('option', { name: 'All Namespaces', exact: true }).click();
  await menu.getByRole('button', { name: 'Apply namespaces', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Namespace filter', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Breadcrumb namespace', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cluster topology', exact: true }).click();
  await page.getByRole('button', { name: 'Diagram namespaces', exact: true }).click();
  const diagramMenu = page.getByRole('dialog', { name: 'Choose Diagram namespaces', exact: true });
  await diagramMenu.getByRole('searchbox').fill('team-129');
  await expect(diagramMenu.getByRole('option')).toHaveCount(1);
  await diagramMenu.getByRole('option', { name: 'team-129', exact: true }).click();
  await diagramMenu.getByRole('button', { name: 'Apply namespaces', exact: true }).click();
  await expect(page.locator('.topology-view')).toHaveAttribute('data-scope', 'namespaces:team-129');
});

test('the focused editor saves the latest draft without changing another open model before apply', async ({ page }) => {
  const errors = captureReactErrors(page);
  await page.goto('/?demo=1'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').getByText('api-gateway-7f9c8b6d5-q7x9z', { exact: true }).dblclick();
  const mainEditor = page.locator('main').getByTestId('yaml-editor');
  await expect(mainEditor.locator('.monaco-editor')).toBeVisible();
  const inspector = page.getByTestId('resource-details');
  await inspector.getByRole('tab', { name: 'YAML', exact: true }).click();
  const editor = inspector.locator('.monaco-editor');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\nkubikiDraft: first\n');
  await expect(inspector.getByText('Unsaved edits', { exact: true })).toBeVisible();
  await page.keyboard.insertText('latestField: current\n');
  await expect(mainEditor.locator('.view-lines')).not.toContainText('latestField');
  await page.keyboard.press('Control+s');
  await expect(inspector.getByText('Clean manifest', { exact: true })).toBeVisible();
  await inspector.getByRole('tab', { name: 'Overview', exact: true }).click();
  await inspector.getByRole('tab', { name: 'YAML', exact: true }).click();
  await expect(inspector.locator('.view-lines')).toContainText('latestField: current');
  expect(errors).toEqual([]);
});

test('an editor module load failure leaves the manifest and inspector usable', async ({ page }) => {
  await page.route('**/*monaco_setup*', (route) => route.abort());
  await page.goto('/?demo=1'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').getByText('api-gateway-7f9c8b6d5-q7x9z', { exact: true }).click();
  const inspector = page.getByTestId('resource-details');
  await inspector.getByRole('tab', { name: 'YAML', exact: true }).click();
  await expect(inspector.getByRole('alert')).toContainText('The advanced editor could not load');
  await expect(inspector.getByRole('textbox', { name: /^YAML source/ })).toHaveValue(/kind: Pod/);
  await inspector.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(inspector.getByRole('region', { name: 'Metadata', exact: true })).toBeVisible();
});

test('Related excludes notifications; each object has its own searchable and paginated Events', async ({ page }) => {
  const reference = { kind: 'Pod', apiVersion: 'v1', name: 'web', namespace: 'backend', uid: 'web-uid' };
  const event = (name: string, ref: object, raw = {}) => ({ apiVersion: 'v1', kind: 'Event', metadata: { uid: name, name, namespace: 'backend', ownerReferences: [reference] }, involvedObject: ref, reason: 'Scheduled', message: name, ...raw });
  await mockResourceLists(page, {
    Namespace: [{ metadata: { uid: 'ns', name: 'backend' } }],
    Pod: [{ apiVersion: 'v1', metadata: { uid: 'web-uid', name: 'web', namespace: 'backend' }, spec: { containers: [] } }],
    Event: [
      ...Array.from({ length: 51 }, (_, index) => event(`notification-${index}`, reference, { lastTimestamp: new Date(1700000000000 + index * 1000).toISOString() })),
      event('warning-event', reference, { type: 'Warning', reason: 'BackOff', message: 'Application restarting', count: 8, lastTimestamp: '2026-10-20T08:00:00Z', source: { component: 'kubelet' } }),
      event('old-incarnation', { ...reference, uid: 'deleted' }),
      event('foreign-group', { ...reference, apiVersion: 'example.com/v1' }),
      event('namespace-event', { kind: 'Namespace', apiVersion: 'v1', name: 'backend', uid: 'ns' }, { reason: 'NamespaceNotice' }),
    ],
  });
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();
  await page.getByRole('button', { name: /^Namespaces(?: \d+)?$/ }).click();
  await page.getByTestId('resource-table').getByText('backend', { exact: true }).click();
  const inspector = page.getByTestId('resource-details');
  await inspector.getByRole('tab', { name: /^Related/ }).click();
  await expect(inspector.getByText('1 matching · 1 relationships')).toBeVisible();
  await expect(inspector.locator('[data-resource-kind="Event"]')).toHaveCount(0);
  await inspector.getByRole('tab', { name: 'Events', exact: true }).click();
  await expect(inspector.getByRole('article')).toHaveCount(1);
  await expect(inspector.getByRole('article', { name: 'NamespaceNotice', exact: true })).toBeVisible();
  await inspector.getByRole('tab', { name: /^Related/ }).click();
  await inspector.getByRole('button').filter({ has: page.locator('[data-resource-kind="Pod"]') }).click();
  await inspector.getByRole('tab', { name: /^Related/ }).click();
  await expect(inspector.locator('[data-resource-kind="Event"]')).toHaveCount(0);
  await inspector.getByRole('tab', { name: 'Events', exact: true }).click();
  await expect(inspector.getByText('52 matching · 52 events · 1 warnings')).toBeVisible();
  await expect(inspector.getByRole('article')).toHaveCount(50);
  const warning = inspector.getByRole('article').first();
  await expect(warning).toHaveAccessibleName('BackOff');
  await expect(warning).toContainText('Warning');
  await expect(warning).toContainText('×8');
  await expect(warning).toContainText('kubelet');
  await expect(warning.locator('time')).toHaveAttribute('datetime', '2026-10-20T08:00:00Z');
  await inspector.getByRole('button', { name: 'Show next 50', exact: true }).click();
  await expect(inspector.getByRole('article')).toHaveCount(52);
  await expect(inspector.getByText('old-incarnation', { exact: true })).toHaveCount(0);
  await inspector.getByPlaceholder('Filter events by reason, message or type…').fill('Warning');
  await expect(inspector.getByRole('article')).toHaveCount(1);
  await expect(inspector.getByRole('article')).toContainText('Application restarting');
});

test('container colors agree across table, details and picker: Completed grey, Pending blue, warning yellow', async ({ page }) => {
  const states = [{ name: 'done', ready: false, state: { terminated: { reason: 'Completed', exitCode: 0 } } }, { name: 'pending', ready: false, state: { waiting: { reason: 'ContainerCreating' } } }, { name: 'warning', ready: false, state: { running: {} } }];
  await mockResourceLists(page, { Pod: [{ metadata: { uid: 'colors', name: 'status-colors', namespace: 'backend' }, spec: { containers: states.map(({ name }) => ({ name, image: 'app' })) }, status: { phase: 'Running', containerStatuses: states } }] });
  await page.route('**/api/k8s/logs?*', (route) => route.fulfill({ json: '2026-10-20T00:00:00Z log\n' }));
  await page.goto('/'); await page.getByTestId('explorer-panel').getByRole('button', { name: 'Expand All', exact: true }).click(); await page.getByTestId('explorer-panel').getByRole('button', { name: /^Pods(?: \d+)?$/ }).click();const row = page.getByTestId('resource-table').locator('tbody tr').filter({ hasText: 'status-colors' });
  const color = async (locator: import('@playwright/test').Locator) => locator.evaluate((el) => getComputedStyle(el).color);
  const tokenColor = async (variable: string) => page.evaluate((variable) => { const probe = document.createElement('span');probe.style.color = `var(${variable})`;document.body.append(probe);const color = getComputedStyle(probe).color;probe.remove();return color; }, variable);
  const completed = row.locator('[data-container-status="terminated"]');const pending = row.locator('[data-container-status="waiting"]');const warning = row.locator('[data-container-status="running"]');
  await expect(completed).toBeVisible();
  expect(await color(completed)).toBe(await tokenColor('--text-muted'));
  expect(await color(warning)).toBe(await tokenColor('--status-warn'));
  expect(await color(pending)).toBe(await tokenColor('--status-pending'));expect(await color(pending)).not.toBe(await color(warning));expect(await color(pending)).not.toBe(await color(completed));
  await row.click();const inspector = page.getByTestId('resource-details');
  expect(await color(inspector.locator('[data-container-status="terminated"]'))).toBe(await color(completed));
  expect(await color(inspector.locator('[data-container-status="waiting"]'))).toBe(await color(pending));
  await inspector.getByRole('button', { name: 'Logs for done', exact: true }).click();await page.getByTestId('logs-toolbar').getByRole('button', { name: 'Select Container' }).click();
  expect(await color(page.getByRole('option', { name: /done/ }).locator('[data-container-status]'))).toBe(await color(completed));
  expect(await color(page.getByRole('option', { name: /pending/ }).locator('[data-container-status]'))).toBe(await color(pending));
  expect(await color(page.getByRole('option', { name: /warning/ }).locator('[data-container-status]'))).toBe(await color(warning));
});
