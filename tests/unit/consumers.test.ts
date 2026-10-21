import { beforeEach, expect, it } from 'vitest';
import { resourceConsumers } from '../../src/core/resources/consumers';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';
import { useResourceStore } from '../../src/state/resource_store';
import type { ResourceItem, ResourceKind } from '../../src/types/k8s';

beforeEach(() => useResourceStore.getState().reset());
function put(kind: ResourceKind, name: string, namespace?: string, fields: Record<string, any> = {}) {
  const item = mapK8sResource({ metadata: { name, namespace, uid: `${kind}/${namespace}/${name}` }, ...fields }, kind);
  const store = useResourceStore.getState();
  store.setResourcesForKind(kind, [...store.resources[kind].values(), item]);
  return item;
}
const roleRef = (kind: string, name: string, apiGroup = 'rbac.authorization.k8s.io') => ({ kind, name, apiGroup });
const consumers = (item: ResourceItem) => resourceConsumers(useResourceStore.getState().resources, item);

it('lists only bindings to the exact namespaced Role and ignores ownership and invalid API groups', () => {
  const role = put('Role', 'reader', 'backend');
  const binding = put('RoleBinding', 'read', 'backend', { roleRef: roleRef('Role', 'reader') });
  put('Role', 'reader', 'other');
  put('RoleBinding', 'read', 'other', { roleRef: roleRef('Role', 'reader') });
  put('RoleBinding', 'wrong-group', 'backend', { roleRef: roleRef('Role', 'reader', 'example.com') });
  put('ConfigMap', 'owned', 'backend', { metadata: { name: 'owned', namespace: 'backend', ownerReferences: [{ kind: 'Role', name: role.name, uid: role.uid, apiVersion: role.apiVersion }] } });
  expect(consumers(role).map(consumer => consumer.resource)).toEqual([binding]);
});

it('lists both binding kinds and aggregating roles as ClusterRole consumers', () => {
  const role = put('ClusterRole', 'reader', undefined, { metadata: { name: 'reader', uid: 'reader', labels: { aggregate: 'yes' } } });
  const local = put('RoleBinding', 'read', 'backend', { roleRef: roleRef('ClusterRole', 'reader') });
  const global = put('ClusterRoleBinding', 'read', undefined, { roleRef: roleRef('ClusterRole', 'reader') });
  const aggregate = put('ClusterRole', 'aggregate', undefined, { aggregationRule: { clusterRoleSelectors: [{ matchLabels: { aggregate: 'yes' } }] } });
  expect(consumers(role).map(consumer => consumer.resource)).toEqual(expect.arrayContaining([local, global, aggregate]));
  expect(consumers(role)).toHaveLength(3);
});

it('resolves and deduplicates ServiceAccount subjects by namespace and retains unloaded references', () => {
  const account = put('ServiceAccount', 'app', 'backend');
  put('ServiceAccount', 'app', 'other');
  const binding = put('RoleBinding', 'read', 'backend', { subjects: [
    { kind: 'ServiceAccount', name: 'app' },
    { kind: 'ServiceAccount', name: 'app', namespace: 'backend' },
    { kind: 'ServiceAccount', name: 'app', namespace: 'unloaded' },
    { kind: 'ServiceAccount', name: 'app', apiGroup: 'example.com' },
  ] });
  expect(consumers(binding)).toHaveLength(2);
  expect(consumers(binding)[0].resource).toBe(account);
  expect(consumers(binding)[1]).toMatchObject({ kind: 'ServiceAccount', name: 'app', namespace: 'unloaded' });
  expect(consumers(binding)[1].resource).toBeUndefined();
});

it('shows User and Group identities without inventing resource objects or namespace defaults on cluster bindings', () => {
  put('ServiceAccount', 'app', 'backend');
  const binding = put('ClusterRoleBinding', 'read', undefined, { subjects: [
    { kind: 'User', name: 'app', apiGroup: 'rbac.authorization.k8s.io' },
    { kind: 'User', name: 'app', apiGroup: 'rbac.authorization.k8s.io' },
    { kind: 'Group', name: 'app', apiGroup: 'rbac.authorization.k8s.io' },
    { kind: 'User', name: 'invalid', apiGroup: 'example.com' },
    { kind: 'ServiceAccount', name: 'app' },
  ] });
  expect(consumers(binding).map(({ kind, name, resource }) => ({ kind, name, resource }))).toEqual([
    { kind: 'User', name: 'app', resource: undefined },
    { kind: 'Group', name: 'app', resource: undefined },
  ]);
});

it('keeps Pod consumers of ConfigMaps and ServiceAccounts working without transitive RBAC matches', () => {
  const config = put('ConfigMap', 'settings', 'backend');
  const account = put('ServiceAccount', 'app', 'backend');
  const pod = put('Pod', 'web', 'backend', { spec: { serviceAccountName: 'app', volumes: [{ configMap: { name: 'settings' } }, { configMap: { name: 'settings' } }] } });
  const binding = put('RoleBinding', 'read', 'backend', { subjects: [{ kind: 'ServiceAccount', name: 'app' }] });
  expect(consumers(config).map(consumer => consumer.resource)).toEqual([pod]);
  expect(consumers(account).map(consumer => consumer.resource)).toEqual([pod]);
  expect(consumers(binding).map(consumer => consumer.resource)).toEqual([account]);
});

it('lists Namespace members and excludes foreign namespaces, cluster objects and Events', () => {
  const namespace = put('Namespace', 'backend');
  const pod = put('Pod', 'web', 'backend');
  const secret = put('Secret', 'settings', 'backend');
  put('Pod', 'web', 'other');
  put('Node', 'worker');
  put('Event', 'notice', 'backend');
  expect(consumers(namespace).map(consumer => consumer.resource)).toEqual([pod, secret]);
});

it('finds secrets referenced in every workload template and Ingress TLS, respecting namespaces', () => {
  const secret = put('Secret', 'settings', 'backend');
  const spec = { imagePullSecrets: [{ name: 'settings' }], containers: [{ name: 'app', env: [{ valueFrom: { secretKeyRef: { name: 'settings', key: 'token' } } }] }], initContainers: [{ name: 'init', envFrom: [{ secretRef: { name: 'settings' } }] }], volumes: [{ projected: { sources: [{ secret: { name: 'settings' } }] } }] };
  const workloads = (['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job'] as const).map(kind => put(kind, 'web', 'backend', { spec: { template: { spec } } }));
  const cron = put('CronJob', 'scheduled', 'backend', { spec: { jobTemplate: { spec: { template: { spec } } } } });
  const ingress = put('Ingress', 'web', 'backend', { spec: { tls: [{ secretName: 'settings' }] } });
  put('Deployment', 'foreign', 'other', { spec: { template: { spec } } });
  expect(consumers(secret).map(consumer => consumer.resource)).toEqual(expect.arrayContaining([...workloads, cron, ingress]));
  expect(consumers(secret)).toHaveLength(7);
});
