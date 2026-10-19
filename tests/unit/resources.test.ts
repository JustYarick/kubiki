import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildResourceGraph, matchesSelector, scopeResourceGraph } from '../../src/core/resources/relationships';
import { resourceKey } from '../../src/core/resources/identity';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';
import { useResourceStore } from '../../src/state/resource_store';
import { useWorkspaceStore } from '../../src/state/workspace_store';
import { useClusterStore } from '../../src/state/cluster_store';
import { useDockStore } from '../../src/state/dock_store';
import { K8sProvider } from '../../src/providers/k8s_provider';
import { buildMockResources } from '../../src/providers/mock/mock_resources';
import type { ResourceItem } from '../../src/types/k8s';

const pod = (namespace = 'default'): ResourceItem => mapK8sResource({ apiVersion: 'v1', metadata: { name: 'web', namespace, uid: `pod-${namespace}`, labels: { app: 'web' } }, spec: { containers: [{ name: 'web', image: 'nginx' }] }, status: { phase: 'Running' } }, 'Pod');
beforeEach(() => { useResourceStore.getState().reset(); useClusterStore.getState().selectContext('test'); useWorkspaceStore.setState({ tabs: [], activeTabId: '', splitTabId: null }); useDockStore.getState().clearAllSessions(); vi.unstubAllGlobals(); });

describe('Resource references', () => {
  it('resolves Pod → ReplicaSet → Deployment with UID ownership, and scopes a neighborhood', () => {
    const deployment = mapK8sResource({ metadata: { uid: 'dep', name: 'web', namespace: 'default' } }, 'Deployment');
    const replicaSet = mapK8sResource({ metadata: { uid: 'rs', name: 'web-123', namespace: 'default', ownerReferences: [{ uid: 'dep', name: 'web', kind: 'Deployment' }] } }, 'ReplicaSet');
    const child = pod(); child.raw!.metadata.ownerReferences = [{ uid: 'rs', name: 'web-123', kind: 'ReplicaSet' }];
    const store = useResourceStore.getState();
    store.setResourcesForKind('Deployment', [deployment]); store.setResourcesForKind('ReplicaSet', [replicaSet]); store.setResourcesForKind('Pod', [child, pod('other')]);
    const graph = buildResourceGraph(useResourceStore.getState().resources);
    expect(scopeResourceGraph(graph, undefined, child, 2).items.size).toBe(3);
    expect(graph.relations.filter((e) => e.type === 'owns' && !e.missing)).toHaveLength(2);
  });
  it('does not link a recreated owner with the same name and a different UID', () => {
    const child = pod(); child.raw!.metadata.ownerReferences = [{ uid: 'deleted-owner', name: 'web', kind: 'Deployment' }];
    const store = useResourceStore.getState(); store.setResourcesForKind('Pod', [child]);
    store.setResourcesForKind('Deployment', [mapK8sResource({ metadata: { uid: 'new-owner', name: 'web', namespace: 'default' } }, 'Deployment')]);
    expect(buildResourceGraph(useResourceStore.getState().resources).relations.find((e) => e.type === 'owns')?.missing?.name).toBe('web');
  });
  it('never treats an empty Service selector as all pods; respects namespaces', () => {
    const service = mapK8sResource({ metadata: { name: 'web', namespace: 'default' }, spec: { selector: {} } }, 'Service');
    const store = useResourceStore.getState(); store.setResourcesForKind('Pod', [pod(), pod('other')]); store.setResourcesForKind('Service', [service]);
    expect(buildResourceGraph(useResourceStore.getState().resources).relations.filter((e) => e.type === 'selects')).toHaveLength(0);
    service.spec!.selector = { app: 'web' };
    expect(buildResourceGraph(useResourceStore.getState().resources).relations.filter((e) => e.type === 'selects')).toHaveLength(1);
    expect(matchesSelector({ app: 'web' }, { matchExpressions: [{ key: 'tier', operator: 'NotIn', values: ['database'] }] })).toBe(true);
  });
  it('resolves Node, Namespace, PVC and StorageClass as cluster or namespace scoped targets correctly', () => {
    const child = pod(); child.raw!.spec.nodeName = 'worker'; child.raw!.spec.volumes = [{ persistentVolumeClaim: { claimName: 'data' } }];
    const store = useResourceStore.getState(); store.setResourcesForKind('Pod', [child]);
    store.setResourcesForKind('Node', [mapK8sResource({ metadata: { name: 'worker' } }, 'Node')]);
    store.setResourcesForKind('Namespace', [mapK8sResource({ metadata: { name: 'default' } }, 'Namespace')]);
    store.setResourcesForKind('PersistentVolumeClaim', [mapK8sResource({ metadata: { name: 'data', namespace: 'default' }, spec: { storageClassName: 'fast', volumeName: 'disk' } }, 'PersistentVolumeClaim')]);
    store.setResourcesForKind('StorageClass', [mapK8sResource({ metadata: { name: 'fast' } }, 'StorageClass')]);
    store.setResourcesForKind('PersistentVolume', [mapK8sResource({ metadata: { name: 'disk' } }, 'PersistentVolume')]);
    const graph = buildResourceGraph(useResourceStore.getState().resources);
    expect(graph.relations.filter((e) => e.missing)).toHaveLength(0);
    expect(graph.relations.find((e) => e.type === 'schedules')?.target).toBe(resourceKey(child));
  });
});

describe('Workspace and session isolation', () => {
  it('opens different YAML tabs for identical names in different namespaces and contexts', () => {
    const store = useWorkspaceStore.getState(); store.openYamlEditor(pod()); store.openYamlEditor(pod('other'));
    expect(useWorkspaceStore.getState().tabs).toHaveLength(2);
    store.openYamlEditor(pod()); expect(useWorkspaceStore.getState().tabs).toHaveLength(2);
    useClusterStore.getState().selectContext('second'); store.openYamlEditor(pod());
    expect(useWorkspaceStore.getState().tabs).toHaveLength(3);
  });
  it('keeps container and namespace log sessions separate and focuses an existing session', () => {
    const store = useDockStore.getState();
    const first = store.openLogs('web', 'default', 'app');
    const other = store.openLogs('web', 'other', 'app');
    expect(first).not.toBe(other); expect(store.openLogs('web', 'default', 'app')).toBe(first);
    expect(useDockStore.getState().sessions).toHaveLength(2);
    store.updateSessionContainer(first, 'sidecar');
    expect(useDockStore.getState().sessions).toHaveLength(3);
    expect(useDockStore.getState().sessions.find((session) => session.id === first)?.container).toBe('app');
    expect(useDockStore.getState().sessions.find((session) => session.id === useDockStore.getState().activeSessionId)?.container).toBe('sidecar');
    store.openPorts(); expect(useDockStore.getState().sessions.find((s) => s.id === useDockStore.getState().activeSessionId)?.type).toBe('ports');
  });
  it('synchronizes selected details after a snapshot, watch update and deletion', () => {
    const store = useResourceStore.getState(); const item = pod(); store.setResourcesForKind('Pod', [item]); store.selectItem(item);
    store.setResourcesForKind('Pod', [{ ...item, status: 'Pending' }]); expect(useResourceStore.getState().selectedItem?.status).toBe('Pending');
    store.applyDelta({ type: 'Applied', payload: { gvk: 'Pod', data: { ...item, status: 'Failed' } } }); expect(useResourceStore.getState().selectedItem?.status).toBe('Failed');
    store.applyDelta({ type: 'Deleted', payload: { gvk: 'Pod', uid: item.uid } }); expect(useResourceStore.getState().selectedItem).toBeNull();
  });
});

describe('Real provider failures', () => {
  it('does not turn a failed ping into a successful demo connection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 403 })));
    await expect(new K8sProvider().pingCluster('prod')).rejects.toThrow('Unauthorized');
  });
  it('does not substitute demo resources for a forbidden list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })));
    await expect(new K8sProvider().getResources('prod', 'Pod')).rejects.toThrow('Forbidden');
  });
  it('preserves the original manifest and zero desired replicas', () => {
    const item = mapK8sResource({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'idle', namespace: 'default' }, spec: { replicas: 0 } }, 'Deployment');
    expect(item.replicas).toBe(0); expect(item.rawYaml).toContain('replicas: 0'); expect(item.rawYaml).toContain('kind: Deployment');
  });
});

it('builds demo manifests with stable UIDs and explicit owner references', () => {
  const first = buildMockResources();
  const second = buildMockResources();
  expect(first.Pod[0].uid).toBe(second.Pod[0].uid);
  expect(first.Pod[0].raw?.metadata.ownerReferences[0].kind).toBe('ReplicaSet');
  expect(first.ReplicaSet.length).toBeGreaterThan(0);
});
