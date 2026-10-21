import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { K8sProvider } from '../../src/providers/k8s_provider';
import { codeForStatus, errorHint, kubectlError, normalizeK8sError, requestError } from '../../src/providers/errors';
import { RESOURCE_TYPES, resourceQuery } from '../../src/core/resources/resource_types';
import { matchesResourceRef, resourceKey, resourceRef, resourceTabId } from '../../src/core/resources/identity';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';
import { buildResourceGraph } from '../../src/core/resources/relationships';
import { useResourceStore } from '../../src/state/resource_store';
import { useClusterStore } from '../../src/state/cluster_store';
import { useWorkspaceStore } from '../../src/state/workspace_store';
import fixtures from '../fixtures/kubectl-errors.json';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
const info = { operation: 'resources', context: 'production' };
const pod = mapK8sResource({ apiVersion: 'v1', metadata: { name: 'web', namespace: 'backend', uid: 'original' }, spec: { containers: [] } }, 'Pod');
beforeEach(() => { vi.unstubAllGlobals(); invoke.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Resource contract', () => {
  it('defines a complete catalog and normalizes namespace scope', () => {
    expect(new Set(RESOURCE_TYPES.map((type) => type.kind)).size).toBe(RESOURCE_TYPES.length);
    expect(new Set(RESOURCE_TYPES.map((type) => type.kind))).toEqual(new Set(Object.keys(useResourceStore.getState().resources).filter(kind => kind !== 'HelmRelease')));
    expect(resourceQuery('production', 'Deployment', 'backend')).toEqual({ context: 'production', group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'backend' });
    expect(resourceQuery('production', 'Pod', 'all').namespace).toBeNull();
    expect(resourceQuery('production', 'Node', 'backend').namespace).toBeNull();
  });
  it('separates contexts, API groups, namespaces and object incarnations', () => {
    expect(resourceRef('production', pod)).toEqual({ context: 'production', group: '', version: 'v1', kind: 'Pod', namespace: 'backend', name: 'web', uid: 'original' });
    const deployment = mapK8sResource({ metadata: { name: 'web', namespace: 'backend', uid: 'dep' } }, 'Deployment');
    expect(deployment.apiVersion).toBe('apps/v1');
    expect(resourceKey(deployment)).not.toBe(resourceKey({ ...deployment, apiVersion: 'example.io/v1' }));
    expect(resourceKey(deployment)).toBe(resourceKey({ ...deployment, apiVersion: 'apps/v1beta1' }));
    expect(resourceTabId('yaml', 'a', pod)).not.toBe(resourceTabId('yaml', 'b', pod));
    expect(resourceTabId('yaml', 'a', pod)).not.toBe(resourceTabId('yaml', 'a', { ...pod, uid: 'replacement' }));
    expect(matchesResourceRef({ ...pod, uid: 'replacement' }, pod)).toBe(false);
    expect(matchesResourceRef({ ...pod, namespace: 'other' }, pod)).toBe(false);
  });
  it('does not resolve an ownerReference to the same kind in another API group', () => {
    useResourceStore.getState().reset();
    const owner = mapK8sResource({ apiVersion: 'apps/v1', metadata: { name: 'web', namespace: 'backend', uid: 'owner' } }, 'Deployment');
    const child = { ...pod, raw: { metadata: { ownerReferences: [{ apiVersion: 'custom.example/v1', kind: 'Deployment', name: 'web', uid: 'owner' }] } } };
    useResourceStore.getState().setResourcesForKind('Deployment', [owner]);
    useResourceStore.getState().setResourcesForKind('Pod', [child]);
    expect(buildResourceGraph(useResourceStore.getState().resources).relations.find((edge) => edge.type === 'owns')?.missing).toMatchObject({ apiVersion: 'custom.example/v1' });
  });
  it('opens a new tab for a recreated object', () => {
    useWorkspaceStore.setState({ tabs: [], activeTabId: '', splitTabId: null });
    useClusterStore.getState().selectContext('production');
    useWorkspaceStore.getState().openYamlEditor(pod);
    useWorkspaceStore.getState().openYamlEditor({ ...pod, uid: 'replacement' });
    expect(useWorkspaceStore.getState().tabs.map((tab) => tab.uid)).toEqual(['original', 'replacement']);
  });
});

describe('Typed errors', () => {
  it.each(fixtures)('classifies kubectl: $message', (fixture) => {
    expect(kubectlError({ stderr: fixture.message }, info)).toMatchObject({ ...fixture, ...info });
  });
  it('recognizes an absent executable and process timeout', () => {
    expect(kubectlError({ code: 'ENOENT' }, info).code).toBe('bridge_unavailable');
    expect(kubectlError({ killed: true, message: 'Process terminated' }, info).code).toBe('timeout');
    expect(codeForStatus(404)).toBe('not_found');
    expect(errorHint(requestError('forbidden', 'No access', info))).toContain('RBAC');
  });
  it('preserves backend cancellation and never upgrades a non-retryable mutation failure', () => {
    const cancelled = normalizeK8sError({ code: 'cancelled', message: 'Operation cancelled', retryable: false }, info);
    expect(cancelled).toMatchObject({ code: 'cancelled', retryable: false });expect(errorHint(cancelled)).toBe('');
    expect(normalizeK8sError({ code: 'timeout', message: 'Refresh to verify the outcome', status: 504, retryable: false }, info).retryable).toBe(false);
  });
  it('accepts JSON IPC and legacy strings while retaining caller identity', () => {
    const error = { code: 'forbidden', message: 'No access', status: 403, retryable: true, context: 'wrong-context' };
    expect(normalizeK8sError(JSON.stringify(error), info)).toMatchObject({ code: 'forbidden', context: 'production', retryable: false });
    expect(normalizeK8sError({ error: 'legacy error' }, info, 404)).toMatchObject({ code: 'not_found', message: 'legacy error' });
  });
});

describe.each(['HTTP', 'Tauri'] as const)('%s provider transport', (transport) => {
  beforeEach(() => { if (transport === 'Tauri') vi.stubGlobal('window', { location: { search: '' }, __TAURI_INTERNALS__: {} }); });
  function respond(data: unknown, status = 200) {
    if (transport === 'Tauri') { if (status >= 400) invoke.mockRejectedValue(data); else invoke.mockResolvedValue(data); }
    else vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(data), { status }))));
  }
  it('sends Secret values only in the request body and preserves the exact IPC identity', async () => {
    const request = { resource: { ...resourceQuery('production', 'Secret', 'backend'), name: 'credentials', uid: 'original' }, resource_version: '10', data: { password: 'c2VjcmV0' } };
    respond({ metadata: { uid: 'original' } });
    if (transport === 'HTTP') { await expect(new K8sProvider().updateSecretData(request)).rejects.toMatchObject({ code: 'forbidden', retryable: false }); expect(fetch).not.toHaveBeenCalled(); return; }
    await new K8sProvider().updateSecretData(request);
    expect(invoke).toHaveBeenCalledWith('mutate_resource', { request: { operation: 'secret', request } });
  });
  it('pins scale requests to the displayed UID and resourceVersion without any frontend approval flag', async () => {
    respond({ success: true });
    if (transport === 'HTTP') { await expect(new K8sProvider().scaleWorkload('production', 'Deployment', 'web', 'backend', 0, 'original', '10')).rejects.toMatchObject({ code: 'forbidden' }); expect(fetch).not.toHaveBeenCalled(); return; }
    await new K8sProvider().scaleWorkload('production', 'Deployment', 'web', 'backend', 0, 'original', '10');
    const request = { operation: 'scale', resource: { ...resourceQuery('production', 'Deployment', 'backend'), name: 'web', uid: 'original' }, resource_version: '10', replicas: 0 };
    expect(invoke).toHaveBeenCalledWith('mutate_resource', { request });
  });
  it('routes namespace metrics through HTTP/native and validates the response identity', async () => {
    const data = { context: 'production', namespace: 'backend', pods: { items: [], error: null }, nodes: { items: null, error: null } };
    respond(data);await expect(new K8sProvider().getOverviewMetrics('production', 'backend')).resolves.toEqual(data);
    if (transport === 'Tauri') expect(invoke).toHaveBeenCalledWith('get_overview_metrics', { context: 'production', namespace: 'backend' });
    else expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('namespace=backend');
    respond({ ...data, context: 'wrong' });await expect(new K8sProvider().getOverviewMetrics('production', 'backend')).rejects.toThrow('invalid response');
  });
  it('passes a qualified list query and maps the manifest', async () => {
    respond({ items: [{ apiVersion: 'apps/v1', metadata: { name: 'web', namespace: 'backend', uid: 'dep' }, spec: { replicas: 0 } }] });
    const result = await new K8sProvider().getResources('production', 'Deployment', 'backend');
    expect(result[0]).toMatchObject({ name: 'web', apiVersion: 'apps/v1', replicas: 0 });
    const expected = resourceQuery('production', 'Deployment', 'backend');
    if (transport === 'Tauri') expect(invoke).toHaveBeenCalledWith('get_resources', expected);
    else {
      const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string, 'http://localhost');
      expect(Object.fromEntries(url.searchParams)).toEqual(expected);
    }
  });
  it.each([403, 404, 504])('preserves structured status %i and query identity', async (status) => {
    const payload = { code: codeForStatus(status), message: `Request failed ${status}`, status, retryable: status === 504 };
    respond(transport === 'HTTP' ? { error: payload } : payload, status);
    await expect(new K8sProvider().getResources('production', 'Pod')).rejects.toMatchObject({ ...payload, operation: 'resources', context: 'production', resource: resourceQuery('production', 'Pod') });
  });
  it('rejects malformed success responses instead of showing an empty cluster or false connection', async () => {
    respond({ error: 'Not a list' });
    await expect(new K8sProvider().getResources('production', 'Pod')).rejects.toMatchObject({ code: 'internal', operation: 'resources' });
    await expect(new K8sProvider().pingCluster('production')).rejects.toMatchObject({ code: 'internal', operation: 'ping' });
  });
});

it('reports a missing bridge and network failures without demo fallback', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>App shell</html>')));
  await expect(new K8sProvider().getResources('production', 'Pod')).rejects.toMatchObject({ code: 'bridge_unavailable', retryable: true });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  await expect(new K8sProvider().getResources('production', 'Pod')).rejects.toMatchObject({ code: 'unavailable', retryable: true });
});

it('bounds a stalled browser request and releases its timeout', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn((_url: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  })));
  const result = new K8sProvider().getResources('production', 'Pod').catch((error) => error);
  await vi.advanceTimersByTimeAsync(20000);
  expect(await result).toMatchObject({ code: 'timeout', status: 504, retryable: true });
  expect(vi.getTimerCount()).toBe(0);
});
