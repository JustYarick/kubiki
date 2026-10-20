import { beforeEach, expect, it } from 'vitest';
import { useResourceStore } from '../../src/state/resource_store';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';
import { buildTopology } from '../../src/core/resources/topology';
import { buildResourceGraph } from '../../src/core/resources/relationships';
import { helmResource } from '../../src/core/resources/helm';
import { resourceKey } from '../../src/core/resources/identity';
import type { ResourceKind } from '../../src/types/k8s';

beforeEach(() => useResourceStore.getState().reset());
function put(kind: ResourceKind, name: string, namespace: string | undefined, fields: Record<string, any> = {}) {
  const item = mapK8sResource({ metadata: { name, namespace, uid: `${kind}/${namespace}/${name}` }, ...fields }, kind);
  const current = [...useResourceStore.getState().resources[kind].values()];
  useResourceStore.getState().setResourcesForKind(kind, [...current, item]); return item;
}
const roleRef = (kind: string, name: string, apiGroup = 'rbac.authorization.k8s.io') => ({ kind, name, apiGroup });

it('connects Pod and workload to their ServiceAccount, bindings and exact roles in focused diagrams', () => {
  const pod = put('Pod', 'web', 'backend', { spec: { serviceAccountName: 'app' } });
  put('Deployment', 'web', 'backend', { spec: { template: { spec: { serviceAccountName: 'app' } } } });
  const account = put('ServiceAccount', 'app', 'backend');
  const binding = put('RoleBinding', 'read', 'backend', { roleRef: roleRef('Role', 'reader'), subjects: [{ kind: 'ServiceAccount', name: 'app', namespace: 'backend' }] });
  const role = put('Role', 'reader', 'backend', { rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get'] }] });
  const graph = buildTopology(useResourceStore.getState().resources, 'resource', role, 3);
  for (const item of [pod, account, binding, role]) expect(graph.items.has(resourceKey(item))).toBe(true);
  expect(graph.relations.some(edge => edge.source === resourceKey(pod) && edge.target === resourceKey(account))).toBe(true);
  expect(graph.relations.some(edge => edge.source === resourceKey(account) && edge.target === resourceKey(binding))).toBe(true);
  expect(graph.relations.some(edge => edge.source === resourceKey(binding) && edge.target === resourceKey(role))).toBe(true);
});

it('loads only referenced cluster RBAC dependencies into a namespace, including role aggregation', () => {
  put('ServiceAccount', 'app', 'backend');
  put('RoleBinding', 'local', 'backend', { roleRef: roleRef('ClusterRole', 'view'), subjects: [{ kind: 'ServiceAccount', name: 'app' }] });
  put('ClusterRoleBinding', 'global', undefined, { roleRef: roleRef('ClusterRole', 'admin'), subjects: [{ kind: 'ServiceAccount', name: 'app', namespace: 'backend' }] });
  put('ClusterRoleBinding', 'unrelated', undefined, { roleRef: roleRef('ClusterRole', 'foreign'), subjects: [{ kind: 'ServiceAccount', name: 'app', namespace: 'other' }] });
  put('ClusterRole', 'view', undefined, { aggregationRule: { clusterRoleSelectors: [{ matchLabels: { aggregate: 'yes' } }] } });
  put('ClusterRole', 'extension', undefined, { metadata: { name: 'extension', uid: 'extension', labels: { aggregate: 'yes' } } });
  put('ClusterRole', 'admin', undefined); put('ClusterRole', 'foreign', undefined);
  const graph = buildTopology(useResourceStore.getState().resources, 'namespace:backend');
  expect([...graph.items.values()].map(item => item.name)).toEqual(expect.arrayContaining(['app', 'local', 'global', 'view', 'admin', 'extension']));
  expect([...graph.items.values()].some(item => item.name === 'foreign' || item.name === 'unrelated')).toBe(false);
  expect(graph.relations.some(edge => edge.label === 'aggregates')).toBe(true);
});

it('does not resolve wrong API groups, other namespaces or User/Group subjects as ServiceAccounts', () => {
  put('ServiceAccount', 'app', 'backend'); put('Role', 'reader', 'backend');
  const binding = put('RoleBinding', 'wrong', 'backend', { roleRef: roleRef('Role', 'reader', 'example.com'), subjects: [{ kind: 'User', name: 'app' }, { kind: 'Group', name: 'app' }, { kind: 'ServiceAccount', name: 'app', namespace: 'other' }] });
  const graph = buildResourceGraph(useResourceStore.getState().resources, { includeContains: false, includeMissing: false });
  expect(graph.relations.filter(edge => edge.target === resourceKey(binding) || edge.source === resourceKey(binding))).toHaveLength(0);
});

it('includes Helm release nodes and exact ownership edges, including cluster-scoped managed resources', () => {
  const release = helmResource('prod', { name: 'web', namespace: 'backend', revision: '2', updated: '', status: 'deployed', chart: 'web-1', app_version: '1' });
  useResourceStore.getState().setResourcesForKind('HelmRelease', [release]);
  const metadata = (name: string, namespace?: string, releaseNamespace = 'backend') => ({ name, namespace, uid: name, labels: { 'app.kubernetes.io/managed-by': 'Helm' }, annotations: { 'meta.helm.sh/release-name': 'web', 'meta.helm.sh/release-namespace': releaseNamespace } });
  const deployment = put('Deployment', 'web', 'backend', { metadata: metadata('web', 'backend') });
  const role = put('ClusterRole', 'web-role', undefined, { metadata: metadata('web-role') });
  put('Deployment', 'foreign', 'backend', { metadata: metadata('foreign', 'backend', 'other') });
  const graph = buildTopology(useResourceStore.getState().resources, 'resource', release, 1);
  expect(graph.items.has(resourceKey(deployment))).toBe(true); expect(graph.items.has(resourceKey(role))).toBe(true);
  expect(graph.relations.filter(edge => edge.type === 'manages')).toHaveLength(2);
  expect([...graph.items.values()].some(item => item.name === 'foreign')).toBe(false);
});

it('never infers Helm ownership from the app instance label alone', () => {
  const release = helmResource('prod', { name: 'web', namespace: 'backend', revision: '1', updated: '', status: 'deployed', chart: 'web', app_version: '' });
  useResourceStore.getState().setResourcesForKind('HelmRelease', [release]);
  put('Pod', 'web', 'backend', { metadata: { uid: 'pod', name: 'web', namespace: 'backend', labels: { 'app.kubernetes.io/instance': 'web' } } });
  expect(buildResourceGraph(useResourceStore.getState().resources).relations.some(edge => edge.type === 'manages')).toBe(false);
});
