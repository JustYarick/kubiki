import { beforeEach, describe, expect, it } from 'vitest';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';
import { resolveContainerEnv } from '../../src/core/resources/pod_env';
import { buildResourceGraph, relatedResourceScope } from '../../src/core/resources/relationships';
import { resourceKey } from '../../src/core/resources/identity';
import { useResourceStore } from '../../src/state/resource_store';
import { useTableViewStore } from '../../src/state/table_view_store';

beforeEach(() => useResourceStore.getState().reset());

describe('ConfigMap data changes after Pod start', () => {
  const pod = mapK8sResource({
    apiVersion: 'v1', kind: 'Pod', metadata: { name: 'web', namespace: 'team', uid: 'p' },
    spec: { containers: [{ name: 'c', env: [{ name: 'MODE', valueFrom: { configMapKeyRef: { name: 'cfg', key: 'MODE' } } }] }] },
    status: { containerStatuses: [{ name: 'c', state: { running: { startedAt: '2026-01-02T00:00:00Z' } } }] },
  }, 'Pod');
  const configMap = (writes: string[]) => mapK8sResource({
    apiVersion: 'v1', kind: 'ConfigMap', data: { MODE: 'new' },
    metadata: { name: 'cfg', namespace: 'team', uid: 'c', creationTimestamp: '2026-01-01T00:00:00Z', managedFields: writes.map(time => ({ manager: 'kubectl', operation: 'Update', time })) },
  }, 'ConfigMap');

  it('reports drift when the payload was rewritten without changing creationTimestamp', () => {
    const cm = configMap(['2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z']);
    expect(cm.raw!.metadata.managedFields).toBeUndefined();
    const result = resolveContainerEnv(pod, 'c', { ConfigMap: new Map([['c', cm]]) });
    expect(result.hasDrift).toBe(true);
    expect(result.entries[0].drift?.clusterValue).toBe('new');
  });

  it('does not report drift for payload written before the container started', () => {
    expect(resolveContainerEnv(pod, 'c', { ConfigMap: new Map([['c', configMap(['2026-01-01T00:00:00Z'])]]) }).hasDrift).toBe(false);
  });
});

describe('Related scope', () => {
  it('keeps explicit cross-namespace references of GitOps resources', () => {
    const app = mapK8sResource({
      apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', metadata: { name: 'shop', namespace: 'argocd', uid: 'app' }, spec: { destination: { name: 'in-cluster' } },
      status: { resources: [{ group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'backend', name: 'api' }] },
    }, 'Application' as any);
    const deployment = mapK8sResource({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'api', namespace: 'backend', uid: 'dep' }, spec: {} }, 'Deployment');
    const resources: any = { Application: new Map([['app', app]]), Deployment: new Map([['dep', deployment]]) };
    const scoped = relatedResourceScope(resources, app) as any;
    expect(scoped.Deployment.size).toBe(1);
    const graph = buildResourceGraph(scoped, { adjacentTo: new Set([resourceKey(app)]) });
    expect(graph.relations.some(edge => edge.source === resourceKey(app) && edge.target === resourceKey(deployment) && !edge.missing)).toBe(true);
  });
});

describe('table view reset', () => {
  it('clears the per-kind key used by resource tables', () => {
    const store = useTableViewStore.getState();
    store.update('kind:Pod', { searchQuery: 'api' });
    store.clear('kind:Pod');
    expect(useTableViewStore.getState().views['kind:Pod']).toBeUndefined();
  });
});
