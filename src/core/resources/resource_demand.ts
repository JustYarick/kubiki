import type { WorkspaceTab } from '../../state/workspace_store';
import type { ResourceItem, ResourceKind } from '../../types/k8s';
import { RESOURCE_TYPES, parseApiVersion } from './resource_types';
import { inNamespaceScope, mergeNamespaceScopes } from './namespace_scope';

export const OVERVIEW_KINDS: readonly ResourceKind[] = ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Service', 'Node', 'Namespace', 'Event'];
const WORKLOADS = new Set(['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet', 'ReplicationController', 'Job', 'CronJob']);
const structuralKinds = RESOURCE_TYPES.filter(type => type.kind !== 'Event').map(type => type.kind as ResourceKind);
const details: Partial<Record<ResourceKind, ResourceKind[]>> = {
  Pod: ['Node', 'ReplicaSet', 'Deployment', 'Job', 'CronJob', 'ServiceAccount', 'PersistentVolumeClaim', 'ConfigMap', 'Secret'],
  Service: ['Pod', 'EndpointSlice', 'Endpoints'],
  Ingress: ['Service', 'Pod', 'IngressClass', 'Secret'],
  PersistentVolumeClaim: ['PersistentVolume', 'StorageClass', 'Pod'],
  PersistentVolume: ['PersistentVolumeClaim', 'StorageClass'],
  Role: ['RoleBinding', 'ClusterRoleBinding', 'ServiceAccount', 'Pod'],
  ClusterRole: ['RoleBinding', 'ClusterRoleBinding', 'ServiceAccount', 'Pod'],
  RoleBinding: ['Role', 'ClusterRole', 'ServiceAccount', 'Pod'],
  ClusterRoleBinding: ['ClusterRole', 'ServiceAccount', 'Pod'],
  ServiceAccount: ['RoleBinding', 'ClusterRoleBinding', 'Role', 'ClusterRole', 'Pod'],
  ConfigMap: ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Pod'],
  Secret: ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Pod', 'ServiceAccount', 'Ingress'],
  Namespace: ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Service', 'ConfigMap', 'Secret', 'Pod'],
  HorizontalPodAutoscaler: ['Deployment', 'StatefulSet', 'ReplicaSet'],
  VerticalPodAutoscaler: ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'],
  PodDisruptionBudget: ['Pod'],
  NetworkPolicy: ['Pod'],
  EndpointSlice: ['Service', 'Pod'],
  Endpoints: ['Service', 'Pod'],
  Kustomization: ['Deployment', 'StatefulSet', 'DaemonSet', 'Service', 'ConfigMap', 'Secret', 'Ingress'],
  Application: ['Deployment', 'StatefulSet', 'DaemonSet', 'Service', 'ConfigMap', 'Secret', 'Ingress'],
  Gateway: ['Service', 'Secret'],
  HTTPRoute: ['Service'],
  GRPCRoute: ['Service'],
  TCPRoute: ['Service'],
  TLSRoute: ['Service'],
  UDPRoute: ['Service'],
  Node: ['Pod'],
};

// Extra direct relationships (including incoming references) beyond Overview's
// data dependencies. Reverse dependencies are included below as well.
const related: Partial<Record<ResourceKind, ResourceKind[]>> = {
  Deployment: ['ReplicaSet'],
  CronJob: ['Job'],
  Pod: ['ReplicaSet', 'ReplicationController', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Service', 'Endpoints', 'EndpointSlice', 'NetworkPolicy', 'PodDisruptionBudget', 'PriorityClass', 'RuntimeClass', 'ResourceClaim', 'ResourceClaimTemplate'],
  Node: ['Endpoints', 'ResourceSlice'],
  Service: ['MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration'],
  PersistentVolume: ['Secret'],
  ClusterRole: ['ClusterRole'],
  ResourceClaim: ['Pod', 'DeviceClass'],
  ResourceClaimTemplate: ['Pod', 'DeviceClass'],
};

/** Watch only potential neighbours of a known resource, rather than the cluster inventory. */
export function relatedResourceKinds(item: ResourceItem): ResourceKind[] {
  // Namespace membership and arbitrary CRD references can span every kind.
  const native = RESOURCE_TYPES.some(type => type.kind === item.kind && type.group === parseApiVersion(item.apiVersion).group);
  const known = item.kind in details || item.kind in related || Object.values(details).some(kinds => kinds?.includes(item.kind));
  if (!native || item.kind === 'Namespace' || !known) return structuralKinds;
  const kinds = new Set<ResourceKind>([...RESOURCE_TYPES.filter(type => !type.namespaced).map(type => type.kind), item.kind, ...(details[item.kind] ?? []), ...(related[item.kind] ?? [])]);
  for (const dependencies of [details, related]) for (const [kind, targets] of Object.entries(dependencies)) {
    if (targets?.includes(item.kind)) kinds.add(kind);
  }
  // Workload templates can reference the same dependencies as Pods.
  if (WORKLOADS.has(item.kind)) for (const kind of ['ServiceAccount', 'ConfigMap', 'Secret', 'PersistentVolumeClaim', 'PriorityClass', 'RuntimeClass', 'ResourceClaim', 'ResourceClaimTemplate']) kinds.add(kind);
  if (['ConfigMap', 'Secret', 'PersistentVolumeClaim', 'ServiceAccount', 'PriorityClass', 'RuntimeClass', 'ResourceClaim', 'ResourceClaimTemplate'].includes(item.kind)) for (const kind of WORKLOADS) kinds.add(kind);
  for (const owner of (item.raw?.metadata ?? item.metadata)?.ownerReferences ?? []) {
    if (typeof owner.kind === 'string') kinds.add(owner.kind);
  }
  const spec = item.raw?.spec ?? item.spec;
  const target = spec?.scaleTargetRef ?? spec?.targetRef;
  if (typeof target?.kind === 'string') kinds.add(target.kind);
  return [...kinds].filter(kind => RESOURCE_TYPES.some(type => type.kind === kind));
}

/** Data dependencies of visible views. Sidebar navigation only needs namespaces and CRDs. */
export function resourceDemand(input: {
  context: string; tabs: readonly WorkspaceTab[]; activeTabId: string; splitTabId: string | null;
  selectedItem: ResourceItem | null; inspectorCollapsed: boolean; rightTab: string;
  eventsVisible?: boolean;
  portsVisible?: boolean;
  selectedNamespace?: string;
}): { kinds: ResourceKind[]; clusterKinds: ReadonlySet<ResourceKind>; scopes: Map<ResourceKind, string> } {
  const selectedNamespace = input.selectedNamespace ?? 'all';
  const scopes = new Map<ResourceKind, string>();
  const kinds = new Set<ResourceKind>(['Namespace', 'CustomResourceDefinition']);
  const request = (kind: ResourceKind, scope = selectedNamespace) => {
    const type = RESOURCE_TYPES.find(type => type.kind === kind);
    if (!type) return;
    kinds.add(kind);
    scopes.set(kind, mergeNamespaceScopes(scopes.get(kind), type.namespaced ? scope : 'all'));
  };
  const clusterKinds = new Set<ResourceKind>();
  if (input.eventsVisible) request('Event');
  if (input.portsVisible) { request('Pod'); request('Service'); }
  const add = (kind?: ResourceKind, inspect = false, scope = selectedNamespace) => {
    if (!kind) return;
    request(kind, scope);
    if (WORKLOADS.has(kind)) {
      request('Pod', scope);
      if (kind === 'Deployment') request('ReplicaSet', scope);
      if (kind === 'CronJob') request('Job', scope);
    }
    // Node details and node table counts intentionally cover every namespace.
    if (kind === 'Node') { request('Pod', 'all'); clusterKinds.add('Pod'); }
    if (inspect) {
      request('Event', scope);
      if (kind === 'HelmRelease') for (const related of ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'Service', 'Ingress', 'PersistentVolumeClaim'] as ResourceKind[]) request(related, scope);
      for (const dependency of details[kind] ?? []) request(dependency, scope);
    }
  };
  const active = input.tabs.find(tab => tab.id === input.activeTabId) ?? input.tabs[0];
  const visible = input.tabs.filter(tab => tab === active || tab.id === input.splitTabId);
  for (const tab of visible) {
    if (tab.context && tab.context !== input.context) continue;
    if (tab.type === 'overview') for (const kind of OVERVIEW_KINDS) request(kind);
    else if (tab.type === 'topology') {
      for (const kind of structuralKinds) request(kind);
      request('Event');
    } else if (tab.type === 'resource-list' || tab.type === 'resource-detail' || tab.type === 'yaml-editor' || tab.type === 'logs' || tab.type === 'terminal') {
      const inScope = inNamespaceScope(selectedNamespace, tab.namespace);
      const scope = tab.type === 'resource-list' || !inScope ? selectedNamespace : tab.namespace ?? (tab.kind === 'Namespace' ? tab.name : undefined) ?? selectedNamespace;
      add(tab.kind, tab.type === 'resource-detail' && inScope, scope);
    }
  }
  if (!input.inspectorCollapsed && input.selectedItem && inNamespaceScope(selectedNamespace, input.selectedItem.namespace)) {
    const item = input.selectedItem;
    const scope = item.namespace ?? (item.kind === 'Namespace' ? item.name : undefined) ?? selectedNamespace;
    add(item.kind, true, scope);
    if (input.rightTab === 'related') for (const kind of relatedResourceKinds(item)) request(kind, scope);
  }
  return { kinds: [...kinds], clusterKinds, scopes };
}
