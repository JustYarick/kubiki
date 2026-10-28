import { test, expect } from '@playwright/test';
import { RESOURCE_TYPES } from '../../src/core/resources/resource_types';

for (const kind of ['Deployment', 'StatefulSet', 'DaemonSet']) {
  test(`${kind} Pods column follows ready / actual total during rollout`, async ({ page }) => {
    await page.addInitScript(({ kind, types }) => {
      const w = window as any;
      const callbacks = new Map();
      let callbackId = 0;
      const watches = new Map<string, any>();
      const owner = (kind: string, name: string) => ({ apiVersion: 'apps/v1', kind, name, uid: name, controller: true });
      const workload = { apiVersion: 'apps/v1', kind, metadata: { uid: 'web', name: 'web', namespace: 'backend' }, spec: { replicas: 2, selector: { matchLabels: { app: 'web' } } }, status: { readyReplicas: 2, desiredNumberScheduled: 2, numberReady: 2 } };
      const rs = { apiVersion: 'apps/v1', kind: 'ReplicaSet', metadata: { uid: 'web-rs', name: 'web-rs', namespace: 'backend', ownerReferences: [owner(kind, 'web')] } };
      const pod = (name: string, phase = 'Running', terminating = false, ready = phase === 'Running') => ({ apiVersion: 'v1', kind: 'Pod', metadata: { uid: name, name, namespace: 'backend', ownerReferences: [owner(kind === 'Deployment' ? 'ReplicaSet' : kind, kind === 'Deployment' ? 'web-rs' : 'web')], ...(terminating ? { deletionTimestamp: '2026-10-28T10:00:00Z' } : {}) }, status: { phase, conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] } });
      const lists: Record<string, object[]> = { [kind]: [workload], ReplicaSet: kind === 'Deployment' ? [rs] : [], Pod: [pod('old-one'), pod('old-two')], Namespace: [{ apiVersion: 'v1', kind: 'Namespace', metadata: { uid: 'backend', name: 'backend' } }] };
      const send = (stream: any, events: object[]) => stream.onEvent.onmessage({ subscription_id: stream.subscriptionId, query: stream.query, messages: events.map(event => ({ sequence: ++stream.sequence, event })) });
      w.__podActivity = {
        update: (name: string, phase: string, terminating = false, ready = phase === 'Running') => send(watches.get('Pod'), [{ type: 'Delta', payload: { type: 'Applied', payload: { data: pod(name, phase, terminating, ready) } } }]),
        remove: (uid: string) => send(watches.get('Pod'), [{ type: 'Delta', payload: { type: 'Deleted', payload: { uid } } }]),
      };
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event: string, id: number) => callbacks.delete(id) };
      w.__TAURI_INTERNALS__ = {
        transformCallback: (callback: unknown) => { callbacks.set(++callbackId, callback); return callbackId; },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (command: string, args: any = {}) => {
          if (command === 'plugin:event|listen') return args.handler;
          if (command === 'get_kube_contexts') return [{ name: 'test', is_current: true }];
          if (command === 'ping_cluster') return { git_version: 'v1.35.0' };
          if (command === 'get_namespaces') return ['backend'];
          if (command === 'get_api_resources') return types;
          if (command === 'get_resource_counts') return {};
          if (command === 'get_resources') return { items: lists[args.kind] ?? [] };
          if (command === 'watch_resources') {
            const stream = { ...args, sequence: 0 };
            watches.set(args.query.kind, stream);
            queueMicrotask(() => send(stream, [{ type: 'Delta', payload: { type: 'Restarted', payload: { items: lists[args.query.kind] ?? [] } } }, { type: 'Status', payload: { phase: 'live', error: null } }]));
          }
        },
      };
    }, { kind, types: RESOURCE_TYPES });
    await page.goto('/');
    const explorer = page.getByTestId('explorer-panel');
    await explorer.getByRole('button', { name: 'Expand All', exact: true }).click();
    await explorer.locator(`[data-resource-type="${kind}"]`).click();
    const row = page.getByTestId('resource-table').locator('tbody tr').filter({ hasText: 'web' });
    await expect(row).toContainText('2/2');
    await expect(row.getByRole('img', { name: '2 ready / 2 total · 0 pending · 0 terminating', exact: true })).toBeVisible();

    // Only Pod events are sent: the workload object and controller counts stay unchanged.
    await page.evaluate(() => {
      (window as any).__podActivity.update('new-one', 'Pending');
      (window as any).__podActivity.update('new-two', 'Pending');
    });
    await expect(row).toContainText('2/4');
    await expect(row.getByRole('img', { name: '2 ready / 4 total · 2 pending · 0 terminating', exact: true })).toBeVisible();
    await page.evaluate(() => {
      (window as any).__podActivity.update('new-one', 'Running');
      (window as any).__podActivity.update('new-two', 'Running');
    });
    await expect(row).toContainText('4/4');
    await page.evaluate(() => {
      (window as any).__podActivity.update('old-one', 'Running', true);
      (window as any).__podActivity.update('old-two', 'Running', true);
    });
    await expect(row).toContainText('2/4');
    await expect(row.getByRole('img', { name: '2 ready / 4 total · 0 pending · 2 terminating', exact: true })).toBeVisible();
    // The ratio still fits the existing default column width.
    await page.evaluate(async kind => {
      const { useUiStore } = await import(/* @vite-ignore */ '/src/state/ui_store.ts' as string);
      useUiStore.getState().setColumnWidth(kind, 'pods', 130);
    }, kind);
    const indicator = row.getByRole('img');
    expect(await indicator.evaluate(element => element.getBoundingClientRect().right <= element.closest('td')!.getBoundingClientRect().right)).toBe(true);

    await page.evaluate(() => {
      (window as any).__podActivity.remove('old-one');
      (window as any).__podActivity.remove('old-two');
    });
    await expect(row).toContainText('2/2');
    await expect(row.getByRole('img', { name: '2 ready / 2 total · 0 pending · 0 terminating', exact: true })).toBeVisible();
    await page.evaluate(() => (window as any).__podActivity.update('new-one', 'Running', false, false));
    await expect(row).toContainText('1/2');
    await page.evaluate(() => {
      (window as any).__podActivity.remove('new-one');
      (window as any).__podActivity.remove('new-two');
    });
    await expect(row.getByRole('img', { name: '0 ready / 0 total · 0 pending · 0 terminating', exact: true })).toBeVisible();
  });
}
