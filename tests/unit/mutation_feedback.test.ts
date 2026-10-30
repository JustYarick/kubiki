import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { changeResource, deleteObject, type ChangeRequest } from '../../src/providers/mutations';
import type { ResourceAction } from '../../src/providers/resource_actions';
import type { ResourceRef } from '../../src/core/resources/resource_types';
import { useNotifications } from '../../src/state/notifications_store';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
const resource: ResourceRef = { context: 'production', group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'apps', name: 'web', uid: 'web-uid' };
const notices = () => useNotifications.getState().toasts;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
  invoke.mockReset().mockResolvedValue({ succeeded: 1, failed: 0, stopped: false, steps: [] });
  useNotifications.setState({ toasts: [] });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const actions: ResourceAction[] = [
  { type: 'restart' }, { type: 'cordon', unschedulable: true }, { type: 'cordon', unschedulable: false },
  { type: 'suspend', suspend: true }, { type: 'suspend', suspend: false },
  { type: 'argo_sync' }, { type: 'argo_refresh', hard: false }, { type: 'argo_refresh', hard: true },
  { type: 'flux_retry' }, { type: 'run_cron_job', name: 'manual-job' },
  { type: 'rollback', revision: { ...resource, kind: 'ReplicaSet', name: 'web-old' }, resource_version: '9' },
  { type: 'config_map_data', data: { password: 'private-topsecret' } },
];
const requests: ChangeRequest[] = [
  ...actions.map(action => ({ operation: 'action' as const, resource, resource_version: '10', action })),
  { operation: 'manifest', context: resource.context, target: { resource, resource_version: '10' }, manifest: 'private-topsecret' },
  { operation: 'manifest', context: resource.context, manifest: 'kind: Secret\nmetadata:\n  name: credentials\n  namespace: apps\ndata:\n  password: private-topsecret\n' },
  { operation: 'scale', resource, resource_version: '10', replicas: 0 },
  { operation: 'evict', resource, resource_version: '10' },
  { operation: 'remove_finalizer', resource, finalizer: 'test/finalizer' },
  { operation: 'secret', request: { resource, resource_version: '10', data: { password: 'private-topsecret' } } },
  { operation: 'batch', primary: resource, steps: [{ operation: 'delete', resource, resource_version: '10' }] },
  { operation: 'node_debug', request: { resource, namespace: 'debug', image: 'busybox' } },
  { operation: 'helm', request: { operation: 'install', context: resource.context, namespace: 'apps', name: 'web', chart: 'repo/web', chart_version: null, values: 'private-topsecret', create_namespace: false, run_hooks: false, wait: false } },
  { operation: 'helm', request: { operation: 'upgrade', context: resource.context, namespace: 'apps', name: 'web', chart: 'repo/web', chart_version: null, values: 'private-topsecret', expected_revision: 2, run_hooks: false, wait: false } },
  { operation: 'helm', request: { operation: 'rollback', context: resource.context, namespace: 'apps', name: 'web', revision: 1, expected_revision: 2, run_hooks: false, wait: false } },
  { operation: 'helm', request: { operation: 'uninstall', context: resource.context, namespace: 'apps', name: 'web', keep_history: false, run_hooks: false } },
  { operation: 'helm', request: { operation: 'repository_set', name: 'charts', url: 'https://example.com/private-topsecret', previous_url: null } },
  { operation: 'helm', request: { operation: 'repository_remove', name: 'charts', expected_url: 'https://example.com/private-topsecret' } },
  { operation: 'helm', request: { operation: 'repository_update', name: null } },
];
it.each(requests.map((request, index) => ({ request, label: `${index}: ${request.operation}` })))('every write has one receipt without sensitive payloads: $label', async ({ request }) => {
  await changeResource(request);
  expect(invoke).toHaveBeenCalledExactlyOnceWith('mutate_resource', { request });
  expect(notices()).toHaveLength(1);
  expect(notices()[0].type).toBe('success');
  expect(JSON.stringify(notices())).not.toContain('private-topsecret');
});
it('waits for backend execution after approval, then returns the original result and one receipt', async () => {
  let finish!: (value: unknown) => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = changeResource({ operation: 'scale', resource, resource_version: '10', replicas: 0 });
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
  expect(notices()).toHaveLength(0);
  // Resolving the confirmation is separate from completing the mutation.
  await invoke('resolve_mutation_confirm', { id: 'confirmation', approved: true });
  expect(notices()).toHaveLength(0);
  const result = { metadata: { name: 'web' }, spec: { replicas: 0 } };
  finish(result);
  expect(await pending).toBe(result);
  expect(notices()).toHaveLength(1);
  expect(notices()[0].description).toContain('production');
  expect(notices()[0].description).toContain('apps/web');
});
it.each(['cancelled', 'forbidden', 'conflict', 'timeout', 'internal'])('never announces success after %s', async code => {
  invoke.mockRejectedValue({ code, message: 'Mutation did not complete', retryable: false });
  await expect(changeResource({ operation: 'scale', resource, resource_version: '10', replicas: 0 })).rejects.toMatchObject({ code });
  expect(notices()).toHaveLength(0);
});
it.each(['resource', 'debug_pod'] as const)('reports accepted %s deletion without claiming finalizer cleanup finished', async operation => {
  invoke.mockResolvedValue({ metadata: { deletionTimestamp: '2026-10-30T12:00:00Z', finalizers: ['test/finalizer'] } });
  await deleteObject(operation === 'resource' ? { operation, resource, resource_version: '10' } : { operation, resource });
  expect(notices()).toHaveLength(1);
  expect(notices()[0]).toMatchObject({ type: 'success', title: 'Resource deletion accepted' });
  expect(notices()[0].description).toContain('Finalizers');
});
it.each([
  { succeeded: 2, failed: 1, stopped: false, expected: 'warn' },
  { succeeded: 0, failed: 1, stopped: true, expected: 'error' },
  { succeeded: 1, failed: 0, stopped: true, expected: 'warn' },
])('reports batch outcome $succeeded/$failed/stopped=$stopped without false success', async ({ expected, ...batch }) => {
  invoke.mockResolvedValue({ ...batch, steps: [] });
  await changeResource({ operation: 'batch', primary: resource, steps: [{ operation: 'drain', resource, resource_version: '10' }] });
  expect(notices()).toHaveLength(1);
  expect(notices()[0].type).toBe(expected);
  await vi.advanceTimersByTimeAsync(10000);
  expect(notices()).toHaveLength(1); // Partial/failure receipts require dismissal.
});
it('warns once when a controller re-adds a finalizer', async () => {
  invoke.mockResolvedValue({ metadata: { finalizers: ['test/finalizer'] } });
  await changeResource({ operation: 'remove_finalizer', resource, finalizer: 'test/finalizer' });
  expect(notices()).toHaveLength(1);
  expect(notices()[0].type).toBe('warn');
});
it('preserves separate receipts for concurrent operations in different clusters', async () => {
  await Promise.all(['production', 'staging'].map(context => changeResource({ operation: 'scale', resource: { ...resource, context }, resource_version: '10', replicas: 0 })));
  expect(notices()).toHaveLength(2);
  expect(notices().map(notice => notice.description)).toEqual(expect.arrayContaining([expect.stringContaining('production'), expect.stringContaining('staging')]));
});
