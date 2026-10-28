import type { WorkspaceTab } from '../../state/workspace_store';
import type { ResourceItem, ResourceKind } from '../../types/k8s';
import { RESOURCE_TYPES, parseApiVersion } from './resource_types';
import { inNamespaceScope, mergeNamespaceScopes, namespaceNames } from './namespace_scope';
import type { ResourceGraph } from './relationships';
import { resourceKey } from './identity';
import { gitOpsReferences } from './gitops';

export const OVERVIEW_KINDS: readonly ResourceKind[] = ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Service', 'Node', 'Namespace', 'Event'];
const WORKLOADS = new Set(['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet', 'ReplicationController', 'Job', 'CronJob']);
export const structuralKinds = RESOURCE_TYPES.filter(type => type.kind !== 'Event').map(type => type.kind as ResourceKind);
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

// Structural edges understood by buildResourceGraph. Diagnostic dependencies
// above are deliberately separate: sharing a detail panel is not a graph edge.
const related: Partial<Record<ResourceKind, ResourceKind[]>> = {
  Pod: ['Node', 'ServiceAccount', 'PersistentVolumeClaim', 'ConfigMap', 'Secret', 'PriorityClass', 'RuntimeClass', 'ResourceClaim', 'ResourceClaimTemplate'],
  Deployment: ['ReplicaSet', 'HorizontalPodAutoscaler'],
  ReplicaSet: ['Pod', 'HorizontalPodAutoscaler'],
  StatefulSet: ['Pod', 'HorizontalPodAutoscaler'],
  DaemonSet: ['Pod'], ReplicationController: ['Pod'], Job: ['Pod'], CronJob: ['Job'],
  Service: ['Pod', 'Endpoints', 'EndpointSlice'],
  Endpoints: ['Pod', 'Node'], EndpointSlice: ['Pod'],
  Ingress: ['Service', 'IngressClass', 'Secret'],
  PersistentVolumeClaim: ['PersistentVolume', 'StorageClass'],
  PersistentVolume: ['PersistentVolumeClaim', 'StorageClass', 'Secret'],
  ServiceAccount: ['Secret'],
  RoleBinding: ['Role', 'ClusterRole', 'ServiceAccount'],
  ClusterRoleBinding: ['ClusterRole', 'ServiceAccount'],
  ClusterRole: ['ClusterRole'],
  HorizontalPodAutoscaler: ['Deployment', 'StatefulSet', 'ReplicaSet', 'ReplicationController'],
  PodDisruptionBudget: ['Pod'], NetworkPolicy: ['Pod'],
  MutatingWebhookConfiguration: ['Service'], ValidatingWebhookConfiguration: ['Service'],
  ValidatingAdmissionPolicyBinding: ['ValidatingAdmissionPolicy'],
  MutatingAdmissionPolicyBinding: ['MutatingAdmissionPolicy'],
  ResourceClaim: ['DeviceClass', 'Pod'], ResourceClaimTemplate: ['DeviceClass'],
  ResourceSlice: ['Node'],
};
const templateDependencies: ResourceKind[] = ['ServiceAccount', 'ConfigMap', 'Secret', 'PersistentVolumeClaim', 'PriorityClass', 'RuntimeClass', 'ResourceClaim', 'ResourceClaimTemplate'];
const boundaryKinds = new Set(['Node', 'Namespace', 'ConfigMap', 'Secret', 'StorageClass', 'HelmRelease']);

/** Watch potential structural neighbours, including incoming references. */
export function relatedResourceKinds(item: ResourceItem): ResourceKind[] {
  const group = parseApiVersion(item.apiVersion).group;
  const native = RESOURCE_TYPES.some(type => type.kind === item.kind && type.group === group);
  if ((native && item.kind === 'Namespace') || (group === 'helm.sh' && item.kind === 'HelmRelease')) return structuralKinds;
  const kinds = new Set<ResourceKind>(['Namespace']);
  if (native) {
    kinds.add(item.kind);
    for (const kind of related[item.kind] ?? []) kinds.add(kind);
    for (const [kind, targets] of Object.entries(related)) if (targets?.includes(item.kind)) kinds.add(kind);
    if (WORKLOADS.has(item.kind)) for (const kind of templateDependencies) kinds.add(kind);
    if (templateDependencies.includes(item.kind)) for (const kind of WORKLOADS) kinds.add(kind);
  }
  // Explicit references work for owners and custom kinds too, without fetching
  // every unrelated API in the catalog merely because the kind is unfamiliar.
  for (const owner of (item.raw?.metadata ?? item.metadata)?.ownerReferences ?? []) {
    if (typeof owner.kind === 'string') kinds.add(owner.kind);
  }
  const spec = item.raw?.spec ?? item.spec;
  const refs = gitOpsReferences(item);
  for (const ref of [...refs.sources, ...refs.managed]) if (ref.local !== false) kinds.add(ref.kind);
  const target = spec?.scaleTargetRef ?? spec?.targetRef;
  if (typeof target?.kind === 'string') kinds.add(target.kind);
  return [...kinds].filter(kind => RESOURCE_TYPES.some(type => type.kind === kind));
}

/** Data needed by this diagram, separate from the global namespace picker. */
export function topologyResourceKinds(scope: string, focus?: ResourceItem, depth = 2, graph?: ResourceGraph): ResourceKind[] {
  if (!scope || scope === 'overview') return [];
  const group = focus ? parseApiVersion(focus.apiVersion).group : '';
  if (scope !== 'resource' || !focus || (focus.kind === 'Namespace' && !group) || (focus.kind === 'HelmRelease' && group === 'helm.sh')) return [...structuralKinds, 'Event'];
  const kinds = new Set<ResourceKind>(relatedResourceKinds(focus));
  // Reuse the worker's relationships instead of rebuilding a potentially large
  // graph on the UI thread just to choose subscriptions. Each response can
  // expose the next required hop; shared dependencies never fan out further.
  let frontier = new Set([resourceKey(focus)]);
  const visited = new Set(frontier);
  for (let step = 1; graph && step < depth && frontier.size; step++) {
    const discovered = new Set<string>();
    for (const edge of graph.relations) {
      if (edge.missing || edge.type === 'contains') continue;
      if (frontier.has(edge.source) && !visited.has(edge.target)) discovered.add(edge.target);
      if (frontier.has(edge.target) && !visited.has(edge.source)) discovered.add(edge.source);
    }
    const next = new Set<string>();
    for (const key of discovered) {
      visited.add(key);
      const item = graph.items.get(key);
      if (!item?.namespace || boundaryKinds.has(item.kind) && item.kind !== focus.kind) continue;
      for (const kind of relatedResourceKinds(item)) kinds.add(kind);
      next.add(key);
    }
    frontier = next;
  }
  kinds.add('Event');
  return [...kinds];
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
    if (!type || type.namespaced && namespaceNames(scope)?.length === 0) return;
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
    if (tab.type === 'overview') {
      for (const kind of OVERVIEW_KINDS) {
        if (selectedNamespace !== 'all' && (kind === 'Node' || kind === 'Namespace')) continue;
        request(kind);
      }
    }
    else if (tab.type === 'topology') {
      // The mounted view owns its chosen scope. A focused tab only needs its
      // target collection to mount before the view registers dependencies.
      if (tab.uid && tab.kind && RESOURCE_TYPES.some(type => type.kind === tab.kind && (!tab.apiVersion || type.group === parseApiVersion(tab.apiVersion).group))) request(tab.kind, tab.namespace ?? selectedNamespace);
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
