import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { K8sProvider } from '../../src/providers/k8s_provider';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';
import { resourceRef } from '../../src/core/resources/identity';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
const item = mapK8sResource({ apiVersion: 'example.io/v1beta1', kind: 'Widget', metadata: { name: 'web', namespace: 'team', uid: 'original', resourceVersion: '10' }, spec: { value: 1 } }, 'Widget' as any);
beforeEach(() => { invoke.mockReset().mockResolvedValue({}); vi.stubGlobal('window', { location: { search: '' }, __TAURI_INTERNALS__: {} }); });
afterEach(() => vi.unstubAllGlobals());
it('saves YAML with a separate editor identity through the shared change gateway', async () => {
  await new K8sProvider().applyManifest('prod', 'editable YAML', item);
  expect(invoke).toHaveBeenCalledExactlyOnceWith('mutate_resource', { request: { operation: 'manifest', context: 'prod', manifest: 'editable YAML', target: { resource: resourceRef('prod', item), resource_version: '10' } } });
});
it('deletes custom resources through the shared delete gateway with the exact served API', async () => {
  await new K8sProvider().deleteResource('prod', item.kind, item.name, item.namespace, item.uid, '10', item.apiVersion);
  expect(invoke).toHaveBeenCalledExactlyOnceWith('delete_resource', { request: { operation: 'resource', resource: resourceRef('prod', item), resource_version: '10' } });
});
it('routes Helm uninstall through the same backend review as other changes', async () => {
  const request = { operation: 'uninstall' as const, context: 'prod', namespace: 'team', name: 'web', expected_revision: 2, keep_history: false, run_hooks: false };
  await new K8sProvider().mutateHelm(request);
  expect(invoke).toHaveBeenCalledExactlyOnceWith('mutate_resource', { request: { operation: 'helm', request } });
});
it.each(['cancelled', 'timeout'])('does not retry or fall back to HTTP after %s', async code => {
  invoke.mockRejectedValue({ code, message: 'Review again', retryable: false }); vi.stubGlobal('fetch', vi.fn());
  await expect(new K8sProvider().applyManifest('prod', 'YAML', item)).rejects.toMatchObject({ code, retryable: false });
  expect(invoke).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
});
it('blocks YAML and delete from browser access before any transport request', async () => {
  vi.stubGlobal('window', { location: { search: '' } }); vi.stubGlobal('fetch', vi.fn());
  const provider = new K8sProvider();
  await expect(provider.applyManifest('prod', 'YAML', item)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(provider.deleteResource('prod', item.kind, item.name, item.namespace, item.uid, '10', item.apiVersion)).rejects.toMatchObject({ code: 'forbidden' });
  expect(invoke).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
