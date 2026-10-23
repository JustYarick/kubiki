import { test, expect } from '@playwright/test';

async function demo(page: import('@playwright/test').Page) {
  await page.goto('/?demo=1');
  await page.waitForFunction(async () => { const path = '/src/state/cluster_store.ts'; const { useClusterStore } = await import(path); return useClusterStore.getState().isConnected && !useClusterStore.getState().isLoading; });
  await page.evaluate(async () => { const path = '/src/providers/mock/mock_watch_engine.ts'; (await import(path)).stopMockWatchEngine(); });
}

test('split tables keep their own search and opening a table preserves the previous filter', async ({ page }) => {
  await demo(page);
  await page.evaluate(async () => { const path = '/src/state/workspace_store.ts'; (await import(path)).useWorkspaceStore.getState().openResourceList('Pod'); });
  await page.getByPlaceholder('Filter pods…').fill('api-gateway');
  await page.evaluate(async () => { const path = '/src/state/workspace_store.ts'; const { useWorkspaceStore: w } = await import(path); const pods = w.getState().activeTabId; w.getState().openResourceList('Deployment'); w.getState().setSplit(pods); });
  await expect(page.getByPlaceholder('Filter pods…')).toHaveValue('api-gateway');
  await expect(page.getByPlaceholder('Filter deployments…')).toHaveValue('');
  await page.getByPlaceholder('Filter deployments…').fill('auth');
  await expect(page.getByPlaceholder('Filter pods…')).toHaveValue('api-gateway');
});

test('Node pod counts update when only the Pod snapshot changes', async ({ page }) => {
  await demo(page);
  await page.evaluate(async () => {
    const storePath = '/src/state/resource_store.ts', workspacePath = '/src/state/workspace_store.ts', mapperPath = '/src/core/utils/k8s_mapper.ts';
    const { useResourceStore: s } = await import(storePath); const { mapK8sResource: map } = await import(mapperPath);
    s.getState().setResourcesForKind('Pod', [map({ metadata: { uid: 'one', name: 'one', namespace: 'default' }, spec: { nodeName: 'audit-node' } }, 'Pod')]);
    s.getState().setResourcesForKind('Node', [map({ metadata: { uid: 'node', name: 'audit-node' }, status: { allocatable: { pods: '110' } } }, 'Node')]);
    (await import(workspacePath)).useWorkspaceStore.getState().openResourceList('Node');
  });
  const row = page.getByTestId('resource-table').locator('tbody tr').filter({ hasText: 'audit-node' });
  await expect(row).toContainText('1 / 110');
  await page.evaluate(async () => { const path = '/src/state/resource_store.ts'; const { useResourceStore: s } = await import(path); const first = [...s.getState().resources.Pod.values()][0] as any; s.getState().setResourcesForKind('Pod', [first, { ...first, uid: 'two', name: 'two' }]); });
  await expect(row).toContainText('2 / 110');
});

test('custom resources named Pod and Gateway do not use built-in details', async ({ page }) => {
  await demo(page);
  const renderers = await page.evaluate(async () => {
    const path = '/src/components/k8s/details/ResourceDetailsRouter.tsx'; const { ResourceDetailsRouter } = await import(path);
    return ['Pod', 'Gateway'].map(kind => ResourceDetailsRouter({ item: { uid: kind, name: kind, kind, apiVersion: 'example.org/v1', namespace: 'default' }, onNavigate() {}, onLogs() {}, onShell() {} }).type.name);
  });
  expect(renderers).toEqual(['GenericResourceDetails', 'GenericResourceDetails']);
});

test('structured batch review shows every target and YAML diff is reserved for manual edits', async ({ page }) => {
  await demo(page);
  await page.evaluate(async () => {
    const path = '/src/state/mutation_confirm_store.ts';
    const resource = { context: 'demo', group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'default', name: 'web', uid: 'web' };
    (await import(path)).useMutationConfirmStore.getState().setPending({ id: 'review', resource, review: 'Unrelated legacy prose', details: { kind: 'batch', warnings: [], steps: Array.from({ length: 200 }, (_, index) => ({ operation: 'RESTART', resource: { ...resource, name: `web-${index}` }, summary: 'Restart workload Pods.' })) } });
  });
  const targets = page.getByRole('list', { name: 'Operation targets' });
  await expect(targets.getByRole('listitem')).toHaveCount(200);
  await expect(targets).toContainText('web-199');
  await expect(page.getByText('YAML changes', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(async () => {
    const path = '/src/state/mutation_confirm_store.ts'; const resource = { context: 'demo', group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'default', name: 'web', uid: 'web' };
    (await import(path)).useMutationConfirmStore.getState().setPending({ id: 'yaml', resource, review: 'YAML review', details: { kind: 'yaml', warnings: [], steps: [{ operation: 'UPDATE', resource, summary: 'Apply edited configuration.', diff: '/spec/replicas: BEFORE 1 → AFTER 2' }] } });
  });
  await expect(page.getByText('YAML changes', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('/spec/replicas: BEFORE 1 → AFTER 2');
});

test('registered workspace panels get independent navigation and unavailable extensions fail visibly', async ({ page }) => {
  await demo(page);
  await page.evaluate(async () => {
    const path = '/src/core/workspace_panels.tsx'; const registry = await import(path);
    (window as any).__unregisterRedis = registry.registerWorkspacePanel({ id: 'redis', title: 'Redis', icon: registry.usePanelRegistry.getState().panels[0].icon, context: 'global', component: ({ visible }: { visible: boolean }) => visible ? 'Redis test panel' : 'Redis test panel (paused)' });
    registry.registerWorkspacePanel({ id: 'kafka', title: 'Kafka', icon: registry.usePanelRegistry.getState().panels[0].icon, context: 'global', component: () => 'Kafka test panel' });
  });
  await page.getByRole('button', { name: 'Redis', exact: true }).click();
  await expect(page.getByText('Redis test panel', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Kafka', exact: true }).click();
  await expect(page.getByText('Kafka test panel', { exact: true })).toBeVisible();
  await expect(page.getByText('Redis test panel (paused)', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Redis test panel (paused)', { exact: true })).toBeHidden();
  await expect(page.getByRole('tab', { name: 'Redis Close tab' })).toBeVisible();
  await page.getByRole('button', { name: 'Redis', exact: true }).click();
  await page.evaluate(() => (window as any).__unregisterRedis());
  await expect(page.getByRole('status').filter({ hasText: 'This panel is unavailable' })).toBeVisible();
});


test('cluster panels keep separate pinned tabs for each context', async ({ page }) => {
  await demo(page);
  const tabs = await page.evaluate(async () => {
    const registryPath = '/src/core/workspace_panels.tsx', clusterPath = '/src/state/cluster_store.ts', workspacePath = '/src/state/workspace_store.ts';
    const registry = await import(registryPath); const { useClusterStore } = await import(clusterPath); const { useWorkspaceStore } = await import(workspacePath);
    const panel = { id: 'cluster-metrics', title: 'Cluster metrics', icon: registry.usePanelRegistry.getState().panels[0].icon, context: 'cluster' as const, component: () => 'Metrics' };
    registry.registerWorkspacePanel(panel);
    useClusterStore.setState({ currentContext: 'one' }); registry.openWorkspacePanel(panel);
    useClusterStore.setState({ currentContext: 'two' }); registry.openWorkspacePanel(panel);
    useClusterStore.setState({ currentContext: 'one' }); registry.openWorkspacePanel(panel);
    return useWorkspaceStore.getState().tabs.filter((tab: { panelId?: string }) => tab.panelId === panel.id).map((tab: { id: string; context?: string }) => ({ id: tab.id, context: tab.context }));
  });
  expect(tabs.map((tab: { context?: string }) => tab.context)).toEqual(['one', 'two']);
  expect(new Set(tabs.map((tab: { id: string }) => tab.id)).size).toBe(2);
});
