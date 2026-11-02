import { expect, test, type Page } from '@playwright/test';
import { openDiagramSettings } from './helpers/topology';

function gate() { let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;}); return {wait, release}; }
const namespace = 'team';
const resource = (kind: string, name: string, group = '', extra: any = {}) => ({apiVersion: group ? `${group}/v1` : 'v1', kind, metadata: {name, uid: name, ...(kind === 'Namespace' ? {} : {namespace}), ...(extra.metadata ?? {})}, ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'metadata'))});
const owner = (kind: string, name: string) => ({apiVersion: 'apps/v1', kind, name, uid: name, controller: true});
const items: Record<string, any[]> = {
  Namespace: [resource('Namespace', 'team')], CustomResourceDefinition: [],
  Pod: [resource('Pod', 'web-pod', '', {metadata: {ownerReferences: [owner('ReplicaSet', 'web-rs')]}, spec: {containers: [{name: 'app', image: 'test'}], volumes: [{name: 'config', configMap: {name: 'web-config'}}]}, status: {phase: 'Running'}})],
  ReplicaSet: [resource('ReplicaSet', 'web-rs', 'apps', {metadata: {ownerReferences: [owner('Deployment', 'web')]}, spec: {replicas: 1}})],
  Deployment: [resource('Deployment', 'web', 'apps', {spec: {replicas: 1}})],
  Service: [resource('Service', 'web-service', '', {spec: {selector: {app: 'web'}}})],
  ConfigMap: [resource('ConfigMap', 'web-config')], Secret: [],
};

async function setup(page: Page, denied = false, focused = false) {
  const discovery = gate(); const helm = gate();
  const waits = Object.fromEntries(['Deployment', 'ReplicaSet', 'Service', 'ConfigMap', 'Secret'].map(kind => [kind, gate()]));
  if (focused) waits.HorizontalPodAutoscaler = gate();
  const fixture: Record<string, any[]> = {...items, ...(focused ? {HorizontalPodAutoscaler: [resource('HorizontalPodAutoscaler', 'web-hpa', 'autoscaling', {apiVersion: 'autoscaling/v2', spec: {scaleTargetRef: {apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'web-rs'}}})]} : {})};
  const requested: string[] = [];
  await page.addInitScript(() => {
    const w = window as any; w.__topologyLayouts = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(data: any, options?: any) {
        if (data?.scope === 'resource' && data.resources) {
          w.__resourceGraphBuilds = (w.__resourceGraphBuilds ?? 0) + 1;
          if (w.__failNextHop && w.__resourceGraphBuilds > 1) {
            queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {data: {id: data.id, error: 'Synthetic next-hop failure'}})));
            return;
          }
        }
        if (data?.cmd === 'layout') {
          w.__topologyLayouts.push(structuredClone(data.graph));
          if (w.__holdLayouts) { w.__releaseLayout = () => super.postMessage(data, options); return; }
        }
        return super.postMessage(data, options);
      }
    };
  });
  await page.route('**/api/k8s/**', async route => {
    const url = new URL(route.request().url()); const path = url.pathname;
    if (path.endsWith('/contexts')) return route.fulfill({json: [{name: 'test', is_current: true}]});
    if (path.endsWith('/ping')) return route.fulfill({json: {version: {gitVersion: 'v1.35.0'}}});
    if (path.endsWith('/namespaces')) return route.fulfill({json: ['team']});
    if (path.endsWith('/api-resources')) {
      await discovery.wait;
      return route.fulfill({json: Object.keys(fixture).map(kind => ({kind, group: ['Deployment', 'ReplicaSet'].includes(kind) ? 'apps' : kind === 'CustomResourceDefinition' ? 'apiextensions.k8s.io' : kind === 'HorizontalPodAutoscaler' ? 'autoscaling' : '', version: kind === 'HorizontalPodAutoscaler' ? 'v2' : 'v1', plural: kind.toLowerCase() + 's', namespaced: !['Namespace', 'CustomResourceDefinition'].includes(kind)}))});
    }
    if (path.endsWith('/resource-counts')) return route.fulfill({json: {Pod: 1, Deployment: 1, ReplicaSet: 1, ConfigMap: 1, Service: 1, Secret: 0}});
    if (path.endsWith('/resources')) {
      const kind = url.searchParams.get('kind')!; requested.push(kind);
      if (waits[kind]) await waits[kind].wait;
      if (denied && kind === 'Secret') return route.fulfill({status: 403, json: {message: 'Secrets forbidden'}});
      return route.fulfill({json: {items: fixture[kind] ?? []}}).catch(() => {});
    }
    if (path.endsWith('/helm/inventory')) { await helm.wait; return route.fulfill({json: [{name: 'web', namespace, revision: '1', updated: '', status: 'deployed', chart: 'web-1.0.0', app_version: '1'}]}).catch(() => {}); }
    if (path.endsWith('/metrics')) return route.fulfill({json: {}});
    return route.fulfill({json: {}});
  });
  await page.goto('/');
  await page.getByRole('button', {name: 'Cluster topology', exact: true}).click();
  discovery.release();
  const view = page.locator('.topology-view:visible');
  await expect(view).toHaveAttribute('data-scope', '');
  return {view, requested, waits, helm};
}

for (const denied of [false, true]) {
  test(`namespace topology waits for complete snapshots and Helm before its first layout${denied ? ', including RBAC failure' : ''}`, async ({page}) => {
    const {view, requested, waits, helm} = await setup(page, denied);
    const choice = view.getByRole('button', {name: /^team\b/});
    await expect(choice).toContainText('Load to count');
    await expect(choice).not.toContainText('0 resources');
    await choice.click();
    expect(await page.evaluate(() => (window as any).__topologyLayouts.length)).toBe(0);
    for (const [kind, wait] of Object.entries(waits)) {
      await expect.poll(() => requested.includes(kind)).toBe(true);
      wait.release();
      await expect.poll(() => page.evaluate(async kind => {
        const {useResourceStore} = await import(/* @vite-ignore */ '/src/state/resource_store.ts' as string);
        return ['live', 'failed'].includes(useResourceStore.getState().watchStates[kind]?.phase);
      }, kind)).toBe(true);
      expect(await page.evaluate(() => (window as any).__topologyLayouts.length)).toBe(0);
      await expect(view.locator('.react-flow__node')).toHaveCount(0);
    }
    helm.release();
    await expect(view).toHaveAttribute('data-phase', 'ready');
    await expect(view.locator('.react-flow__node').filter({hasText: 'web-config'})).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__topologyLayouts.length)).toBe(1);
    const layout = await page.evaluate(() => JSON.stringify((window as any).__topologyLayouts[0]));
    for (const kind of ['Pod', 'ReplicaSet', 'Deployment', 'ConfigMap', 'HelmRelease']) expect(layout).toContain(kind);
    if (denied) await expect(view).toContainText('Some resource types are unavailable');
    await expect(view.locator('.topology-summary')).toContainText('7 resources');
    await openDiagramSettings(page);
    await page.getByRole('checkbox', {name: 'Show ConfigMap', exact: true}).uncheck();
    await expect(view.locator('.topology-summary')).toContainText('6/7 resources');
    expect(await page.evaluate(() => (window as any).__topologyLayouts.length)).toBe(1);
  });
}


for (const failed of [false, true]) test(`focused topology ${failed ? 'retains failed discovery without retrying it' : 'discovers the next dependency hop before its only initial layout'}`, async ({page}) => {
  const {requested, waits, helm} = await setup(page, false, true);
  await page.evaluate(failed => { (window as any).__failNextHop = failed; }, failed);
  await page.evaluate(async raw => {
    const {useWorkspaceStore} = await import(/* @vite-ignore */ '/src/state/workspace_store.ts' as string);
    const {mapK8sResource} = await import(/* @vite-ignore */ '/src/core/utils/k8s_mapper.ts' as string);
    useWorkspaceStore.getState().openTopology(mapK8sResource(raw, 'Pod'));
  }, items.Pod[0]);
  for (const [kind, wait] of Object.entries(waits)) if (!['Deployment', 'HorizontalPodAutoscaler'].includes(kind)) wait.release();
  helm.release();
  await expect.poll(() => requested.includes('HorizontalPodAutoscaler'), {timeout: 10000}).toBe(true);
  expect(await page.evaluate(() => (window as any).__topologyLayouts.length)).toBe(0);
  waits.Deployment.release();
  await expect.poll(() => page.evaluate(async () => {
    const {useResourceStore} = await import(/* @vite-ignore */ '/src/state/resource_store.ts' as string);
    return useResourceStore.getState().watchStates.Deployment?.hasSnapshot;
  })).toBe(true);
  expect(await page.evaluate(() => (window as any).__topologyLayouts.length)).toBe(0);
  waits.HorizontalPodAutoscaler.release();
  const view = page.locator('.topology-view:visible');
  if (failed) {
    await expect(view.getByRole('alert')).toContainText('Synthetic next-hop failure');
    // The graph bridge throttles live builds at one second: no automatic retry
    // should be queued just because the failed pass would lose its dependencies.
    await page.waitForTimeout(1200);
    expect(await page.evaluate(() => (window as any).__resourceGraphBuilds)).toBe(2);
    expect(await page.evaluate(() => (window as any).__topologyLayouts.length)).toBe(0);
    return;
  }
  await expect(view).toHaveAttribute('data-phase', 'ready');
  await expect(view.locator('.react-flow__node').filter({hasText: 'web-pod'})).toBeVisible();
  expect(await page.evaluate(() => (window as any).__topologyLayouts.length)).toBe(1);
  const layout = await page.evaluate(() => JSON.stringify((window as any).__topologyLayouts[0]));
  expect(layout).toContain('Deployment'); expect(layout).toContain('HorizontalPodAutoscaler');
});

test('a live structural update keeps the previous diagram and camera while arranging', async ({page}) => {
  const {view, waits, helm} = await setup(page);
  Object.values(waits).forEach(wait => wait.release()); helm.release();
  await view.getByRole('button', {name: /^team\b/}).click();
  await expect(view).toHaveAttribute('data-phase', 'ready');
  await expect(view.getByText('Arranging topology…', {exact: true})).toHaveCount(0);
  const bounds = (await view.locator('.topology-canvas').boundingBox())!;
  await page.mouse.move(bounds.x + 5, bounds.y + 5); await page.mouse.down();
  await page.mouse.move(bounds.x + 55, bounds.y + 45); await page.mouse.up();
  const viewport = view.locator('.react-flow__viewport');
  const camera = await viewport.getAttribute('style');
  await page.evaluate(async () => {
    const w = window as any; w.__holdLayouts = true;
    const {useResourceStore} = await import(/* @vite-ignore */ '/src/state/resource_store.ts' as string);
    const {mapK8sResource} = await import(/* @vite-ignore */ '/src/core/utils/k8s_mapper.ts' as string);
    const state = useResourceStore.getState();
    // An overlapping diagram or Helm details can project equivalent releases
    // with different identities; this must not block later graph updates.
    state.setResourcesForKind('HelmRelease', [...state.resources.HelmRelease.values()].map(item => structuredClone(item)));
    state.applyWatchCommit('ConfigMap', {changes: [{type: 'apply', item: mapK8sResource({apiVersion: 'v1', kind: 'ConfigMap', metadata: {name: 'next-config', uid: 'next-config', namespace: 'team'}}, 'ConfigMap')}], state: state.watchStates.ConfigMap});
  });
  await expect.poll(() => page.evaluate(() => (window as any).__topologyLayouts.length)).toBe(2);
  await expect(view.getByText('Arranging topology…', {exact: true})).toBeVisible();
  await expect(view.locator('.react-flow__node').first()).toBeVisible();
  expect(await viewport.getAttribute('style')).toBe(camera);
  await page.evaluate(() => { (window as any).__holdLayouts = false; (window as any).__releaseLayout(); });
  await expect(view.getByText('Arranging topology…', {exact: true})).toHaveCount(0);
  expect(await viewport.getAttribute('style')).toBe(camera);
  await expect(view.locator('.topology-summary')).toContainText('8 resources');
});
