import type { ResourceItem, ResourceKind } from '../../types/k8s';
import { matchesResourceRef, resourceKey } from './identity';
import { RESOURCE_TYPES, apiVersionFor, parseApiVersion } from './resource_types';
import { gitOpsReferences, gitOpsFamily } from './gitops';

export type RelationType = 'owns' | 'selects' | 'routes' | 'schedules' | 'uses' | 'binds' | 'contains' | 'manages';
export interface ResourceRelation {
  id: string;
  source: string;
  target: string;
  type: RelationType;
  label: string;
  missing?: { kind: string; name: string; namespace?: string; apiVersion: string };
}
export interface ResourceGraph { items: Map<string, ResourceItem>; relations: ResourceRelation[] }
export interface GraphBuildOptions {
  adjacentTo?: ReadonlySet<string>;
  includeContains?: boolean;
  includeMissing?: boolean;
  maxNodes?: number;
  maxEdges?: number;
}
export class GraphLimitError extends Error {
  constructor(message: string) { super(message); this.name = 'GraphLimitError'; }
}

export function matchesSelector(labels: Record<string, string>, selector: any): boolean {
  if (!selector || typeof selector !== 'object') return false;
  const matchLabels = selector.matchLabels ?? (selector.matchExpressions ? {} : selector);
  const expressions: any[] = selector.matchExpressions ?? [];
  if (Object.keys(matchLabels).length === 0 && expressions.length === 0) return false;
  if (!Object.entries(matchLabels).every(([key, value]) => labels[key] === value)) return false;
  return expressions.every(({ key, operator, values = [] }) => {
    const exists = Object.prototype.hasOwnProperty.call(labels, key);
    if (operator === 'In') return exists && values.includes(labels[key]);
    if (operator === 'NotIn') return !exists || !values.includes(labels[key]);
    if (operator === 'Exists') return exists;
    if (operator === 'DoesNotExist') return !exists;
    return false;
  });
}

const SINGLE_NAMESPACE_KINDS = new Set([
  'Pod', 'ReplicaSet', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicationController',
  'Job', 'CronJob', 'ConfigMap', 'Secret', 'ServiceAccount', 'PersistentVolumeClaim',
  'Service', 'Ingress', 'NetworkPolicy', 'PodDisruptionBudget', 'HorizontalPodAutoscaler',
  'Role', 'Lease', 'ResourceQuota', 'LimitRange',
]);

const namespaceCache = new WeakMap<Map<string, ResourceItem>, Map<string, Map<string, ResourceItem>>>();
/** Reuse namespace slices of unchanged watch buckets before worker serialization. */
export function relatedResourceScope(resources: Record<ResourceKind, Map<string, ResourceItem>>, focus: ResourceItem) {
  const namespace = focus.namespace ?? (focus.kind === 'Namespace' ? focus.name : undefined);
  if (!namespace) return resources;
  return Object.fromEntries(Object.entries(resources).map(([kind, map]) => {
    // Keep kinds that may carry explicit cross-namespace references intact.
    if (!SINGLE_NAMESPACE_KINDS.has(kind)) return [kind, map];
    let cached = namespaceCache.get(map);
    if (!cached) { cached = new Map(); namespaceCache.set(map, cached); }
    let scoped = cached.get(namespace);
    if (!scoped) {
      scoped = new Map([...map].filter(([, item]) => !item.namespace || item.namespace === namespace));
      if (cached.size >= 8) cached.delete(cached.keys().next().value!);
      cached.set(namespace, scoped);
    }
    return [kind, scoped];
  })) as typeof resources;
}

/** Resolve API references, never infer ownership from a resource's name. */
export function buildResourceGraph(resources: Record<ResourceKind, Map<string, ResourceItem>>, options: GraphBuildOptions = {}): ResourceGraph {
  // Events describe notifications about objects, not structural relationships.
  const all = Object.values(resources).flatMap((map) => [...map.values()].filter((item) => item.kind !== 'Event'));
  const items = new Map(all.map((item) => [resourceKey(item), item]));
  const adjacentItems = options.adjacentTo ? [...options.adjacentTo].map((key) => items.get(key)).filter((item): item is ResourceItem => !!item) : undefined;
  const adjacentNamespaces = adjacentItems && adjacentItems.length > 0 && adjacentItems.every((item) => !!item.namespace && item.kind !== 'HelmRelease' && !gitOpsFamily(item))
    ? new Set(adjacentItems.map((item) => item.namespace!))
    : undefined;
  const byGroupKind = new Map<string, ResourceItem[]>();
  for (const item of all) {
    const key = JSON.stringify([parseApiVersion(item.apiVersion).group, item.kind]);
    if (!byGroupKind.has(key)) byGroupKind.set(key, []);
    byGroupKind.get(key)!.push(item);
  }
  const byUid = new Map(all.map((item) => [item.uid, item]));
  const relations = new Map<string, ResourceRelation>();
  const included = new Set(options.adjacentTo ?? items.keys());
  if (!options.adjacentTo && included.size > (options.maxNodes ?? Infinity)) throw new GraphLimitError(`This scope contains ${included.size} resources. Select a smaller scope (limit ${options.maxNodes}).`);
  const activePods = options.adjacentTo ? [...options.adjacentTo].map((key) => items.get(key)).filter((item): item is ResourceItem => item?.kind === 'Pod') : undefined;
  let podLabelIndex: Map<string, Map<string, ResourceItem>> | undefined;
  const selectorCandidates = (namespace: string | undefined, selector: Record<string, string>): Iterable<ResourceItem> => {
    if (!podLabelIndex) {
      podLabelIndex = new Map();
      for (const pod of resources.Pod.values()) for (const [key, value] of Object.entries(pod.labels ?? {})) {
        const id = JSON.stringify([pod.namespace, key, value]);
        if (!podLabelIndex.has(id)) podLabelIndex.set(id, new Map());
        podLabelIndex.get(id)!.set(pod.uid, pod);
      }
    }
    let smallest: Map<string, ResourceItem> | undefined;
    for (const [key, value] of Object.entries(selector)) {
      const candidates = podLabelIndex.get(JSON.stringify([namespace, key, value]));
      if (!candidates) return [];
      if (!smallest || candidates.size < smallest.size) smallest = candidates;
    }
    return smallest?.values() ?? [];
  };
  const link = (source: string, target: string, type: RelationType, label: string, missing?: ResourceRelation['missing']) => {
    if (missing && options.includeMissing === false) return;
    if (options.includeContains === false && type === 'contains') return;
    if (options.adjacentTo && !options.adjacentTo.has(source) && !options.adjacentTo.has(target)) return;
    const id = JSON.stringify([source, target, type]);
    if (missing && relations.has(id) && !relations.get(id)!.missing) return;
    if (!relations.has(id) && relations.size >= (options.maxEdges ?? Infinity)) throw new GraphLimitError(`This scope exceeds ${options.maxEdges} relationships. Reduce the depth or choose a smaller resource.`);
    for (const key of missing ? [] : [source, target]) if (items.has(key)) {
      included.add(key);
      if (included.size > (options.maxNodes ?? Infinity)) throw new GraphLimitError(`This scope exceeds ${options.maxNodes} resources. Reduce the depth or open a single Pod.`);
    }
    relations.set(id, { id, source, target, type, label, missing });
  };
  const reference = (from: ResourceItem, kind: string, name: string | undefined, namespace: string | null = from.namespace ?? null, type: RelationType = 'uses', reverse = false, uid?: string, apiVersion?: string) => {
    if (!name || name === '-' || kind === 'Event') return;
    const group = apiVersion === undefined ? undefined : parseApiVersion(apiVersion).group;
    const builtin = RESOURCE_TYPES.find((resource) => resource.kind === kind && (group === undefined || group === resource.group));
    const reference = { kind, name, namespace: builtin?.namespaced === false ? undefined : namespace ?? undefined, uid, apiVersion: apiVersion ?? (builtin ? apiVersionFor(builtin) : '') };
    const key = resourceKey(reference);
    const target = uid ? byUid.get(uid) : items.get(key);
    // A recreated object with the same name is not the owner referenced by the old UID.
    const valid = target && matchesResourceRef(target, reference);
    const targetKey = valid ? resourceKey(target) : key;
    const missing = valid ? undefined : reference;
    link(reverse ? targetKey : resourceKey(from), reverse ? resourceKey(from) : targetKey, type, type, missing);
  };

  for (const item of all) {
    if (adjacentNamespaces && item.namespace && !adjacentNamespaces.has(item.namespace) && SINGLE_NAMESPACE_KINDS.has(item.kind)) {
      continue;
    }
    const raw = item.raw ?? { metadata: item.metadata, spec: item.spec, status: item.statusRaw };
    const spec: any = raw.spec ?? {};
    const metadata: any = raw.metadata ?? {};
    const group = parseApiVersion(item.apiVersion).group;
    const native = RESOURCE_TYPES.some(type => type.kind === item.kind && type.group === group);
    if ((native && item.kind === 'HorizontalPodAutoscaler') || (group === 'autoscaling.k8s.io' && item.kind === 'VerticalPodAutoscaler')) {
      const target = spec.scaleTargetRef ?? spec.targetRef;
      if (target) reference(item, target.kind, target.name, item.namespace, 'uses', false, undefined, target.apiVersion);
    }
    if (native && item.kind === 'EndpointSlice') {
      reference(item, 'Service', metadata.labels?.['kubernetes.io/service-name'], item.namespace, 'routes', true);
      for (const endpoint of raw.endpoints ?? []) if (endpoint.targetRef) {
        const ref = endpoint.targetRef;
        reference(item, ref.kind, ref.name, ref.namespace ?? item.namespace, 'routes', false, ref.uid, ref.apiVersion);
      }
    }
    if (native && item.kind === 'Endpoints') {
      reference(item, 'Service', item.name, item.namespace, 'routes', true);
      for (const subset of raw.subsets ?? []) for (const address of [...(subset.addresses ?? []), ...(subset.notReadyAddresses ?? [])]) {
        const ref = address.targetRef;
        if (ref) reference(item, ref.kind, ref.name, ref.namespace ?? item.namespace, 'routes', false, ref.uid, ref.apiVersion);
        reference(item, 'Node', address.nodeName, null);
      }
    }
    if (group === 'gateway.networking.k8s.io') {
      const gatewayRef = (ref: any, defaultKind = 'Gateway', defaultGroup = 'gateway.networking.k8s.io', type: RelationType = 'routes') => {
        if (!ref?.name) return;
        const group = ref.group ?? defaultGroup;
        reference(item, ref.kind ?? defaultKind, ref.name, ref.namespace ?? item.namespace, type, false, undefined, group ? `${group}/v1` : 'v1');
      };
      if (item.kind === 'Gateway') {
        reference(item, 'GatewayClass', spec.gatewayClassName, null, 'uses', false, undefined, `${group}/v1`);
      }
      if (item.kind === 'Gateway' || item.kind === 'ListenerSet') {
        if (spec.parentRef) gatewayRef(spec.parentRef);
        for (const listener of spec.listeners ?? []) for (const ref of listener.tls?.certificateRefs ?? []) gatewayRef(ref, 'Secret', '', 'uses');
      }
      if (item.kind.endsWith('Route')) {
        for (const ref of spec.parentRefs ?? []) gatewayRef(ref);
        for (const rule of spec.rules ?? []) {
          for (const ref of rule.backendRefs ?? []) gatewayRef(ref, 'Service', '');
          for (const filter of rule.filters ?? []) if (filter.type === 'RequestMirror') gatewayRef(filter.requestMirror?.backendRef, 'Service', '');
        }
      }
      if (item.kind === 'GatewayClass' && spec.parametersRef) {
        gatewayRef(spec.parametersRef, spec.parametersRef.kind, spec.parametersRef.group, 'uses');
      }
      if (item.kind === 'BackendTLSPolicy') {
        for (const ref of spec.targetRefs ?? []) gatewayRef(ref, 'Service', '', 'uses');
        for (const ref of spec.validation?.caCertificateRefs ?? []) gatewayRef(ref, 'ConfigMap', '', 'uses');
      }
      if (item.kind === 'ReferenceGrant') for (const ref of spec.to ?? []) gatewayRef(ref, ref.kind, ref.group, 'binds');
    }
    if (native && ['MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration'].includes(item.kind)) {
      for (const webhook of raw.webhooks ?? []) reference(item, 'Service', webhook.clientConfig?.service?.name, webhook.clientConfig?.service?.namespace);
    }
    if (native && item.kind.endsWith('AdmissionPolicyBinding')) {
      const policyKind = item.kind.startsWith('Validating') ? 'ValidatingAdmissionPolicy' : 'MutatingAdmissionPolicy';
      reference(item, policyKind, spec.policyName, null, 'binds');
      const policy = (byGroupKind.get(JSON.stringify(['admissionregistration.k8s.io', policyKind])) ?? []).find(candidate => candidate.name === spec.policyName);
      const paramKind = policy?.raw?.spec?.paramKind;
      if (paramKind && spec.paramRef?.name) reference(item, paramKind.kind, spec.paramRef.name, spec.paramRef.namespace ?? item.namespace, 'uses', false, undefined, paramKind.apiVersion);
    }
    if (native && ['ResourceClaim', 'ResourceClaimTemplate'].includes(item.kind)) {
      const claimSpec = item.kind === 'ResourceClaimTemplate' ? spec.spec : spec;
      for (const request of claimSpec?.devices?.requests ?? []) for (const allocation of [request, request.exactly, ...(request.firstAvailable ?? [])]) reference(item, 'DeviceClass', allocation?.deviceClassName, null);
      for (const ref of raw.status?.reservedFor ?? []) if (ref.resource === 'pods' && !ref.apiGroup) reference(item, 'Pod', ref.name, item.namespace, 'uses', true, ref.uid);
    }
    if (native && item.kind === 'ResourceSlice') reference(item, 'Node', spec.nodeName, null, 'schedules', true);
    if (gitOpsFamily(item)) {
      const refs = gitOpsReferences(item);
      for (const [managed, entries] of [[false, refs.sources], [true, refs.managed]] as const) for (const ref of entries) {
        if (ref.local === false) continue;
        const group = ref.group ?? all.find(candidate => candidate.kind === ref.kind && gitOpsFamily(candidate) === 'flux')?.apiVersion.split('/')[0];
        const builtin = RESOURCE_TYPES.find(type => type.kind === ref.kind && (group === undefined || type.group === group));
        const apiVersion = group !== undefined ? (group ? `${group}/${ref.version ?? builtin?.version ?? 'v1'}` : ref.version ?? 'v1') : undefined;
        reference(item, ref.kind, ref.name, ref.namespace ?? null, managed ? 'manages' : 'uses', false, undefined, apiVersion);
      }
    }
    for (const owner of metadata.ownerReferences ?? []) {
      const target = owner.uid ? byUid.get(owner.uid) : undefined;
      reference(item, owner.kind, owner.name, target ? target.namespace ?? null : item.namespace, 'owns', true, owner.uid, owner.apiVersion);
    }
    if (item.namespace) reference(item, 'Namespace', item.namespace, null, 'contains', true);
    const annotations = metadata.annotations ?? {};
    if (item.kind !== 'HelmRelease' && metadata.labels?.['app.kubernetes.io/managed-by'] === 'Helm' && annotations['meta.helm.sh/release-name'] && annotations['meta.helm.sh/release-namespace']) {
      reference(item, 'HelmRelease', annotations['meta.helm.sh/release-name'], annotations['meta.helm.sh/release-namespace'], 'manages', true, undefined, 'helm.sh/v1');
    }
    if (native && (item.kind === 'RoleBinding' || item.kind === 'ClusterRoleBinding')) {
      const role = raw.roleRef;
      if (role?.apiGroup === 'rbac.authorization.k8s.io' && (role.kind === 'ClusterRole' || item.kind === 'RoleBinding' && role.kind === 'Role')) reference(item, role.kind, role.name, role.kind === 'ClusterRole' ? null : item.namespace, 'binds');
      for (const subject of raw.subjects ?? []) if (subject.kind === 'ServiceAccount' && !subject.apiGroup) {
        const namespace = subject.namespace || (item.kind === 'RoleBinding' ? item.namespace : undefined);
        if (namespace) reference(item, 'ServiceAccount', subject.name, namespace, 'binds', true);
      }
    }
    if (native && item.kind === 'ServiceAccount') {
      for (const secret of [...(raw.secrets ?? []), ...(raw.imagePullSecrets ?? [])]) reference(item, 'Secret', secret.name);
    }
    if (native && item.kind === 'ClusterRole' && raw.aggregationRule?.clusterRoleSelectors?.length) {
      for (const candidate of resources.ClusterRole.values()) if (candidate.uid !== item.uid && raw.aggregationRule.clusterRoleSelectors.some((selector: any) => Object.keys(selector).length === 0 || matchesSelector(candidate.labels ?? {}, selector))) link(resourceKey(item), resourceKey(candidate), 'uses', 'aggregates');
    }
    const podTemplateKind = native && ['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet', 'ReplicationController', 'Job', 'CronJob'].includes(item.kind);
    const template = podTemplateKind ? item.kind === 'CronJob' ? spec.jobTemplate?.spec?.template?.spec : spec.template?.spec : undefined;
    if (native && item.kind === 'Pod') {
      reference(item, 'Node', spec.nodeName ?? item.node, null, 'schedules', true);
    }
    const podSpec = native && item.kind === 'Pod' ? spec : template;
    if (podSpec) {
      reference(item, 'ServiceAccount', podSpec.serviceAccountName || 'default');
      reference(item, 'PriorityClass', podSpec.priorityClassName, null);
      reference(item, 'RuntimeClass', podSpec.runtimeClassName, null);
      for (const claim of podSpec.resourceClaims ?? []) {
        reference(item, 'ResourceClaim', claim.resourceClaimName);
        reference(item, 'ResourceClaimTemplate', claim.resourceClaimTemplateName);
      }
      for (const claim of raw.status?.resourceClaimStatuses ?? []) reference(item, 'ResourceClaim', claim.resourceClaimName);
      for (const secret of podSpec.imagePullSecrets ?? []) reference(item, 'Secret', secret.name);
      for (const volume of podSpec.volumes ?? []) {
        reference(item, 'PersistentVolumeClaim', volume.persistentVolumeClaim?.claimName);
        reference(item, 'ConfigMap', volume.configMap?.name);
        reference(item, 'Secret', volume.secret?.secretName);
        for (const source of volume.projected?.sources ?? []) {
          reference(item, 'ConfigMap', source.configMap?.name);
          reference(item, 'Secret', source.secret?.name);
        }
      }
      for (const container of [...(podSpec.containers ?? []), ...(podSpec.initContainers ?? []), ...(podSpec.ephemeralContainers ?? [])]) {
        for (const env of container.env ?? []) {
          reference(item, 'ConfigMap', env.valueFrom?.configMapKeyRef?.name);
          reference(item, 'Secret', env.valueFrom?.secretKeyRef?.name);
        }
        for (const env of container.envFrom ?? []) {
          reference(item, 'ConfigMap', env.configMapRef?.name);
          reference(item, 'Secret', env.secretRef?.name);
        }
      }
    }
    const selectsPods = native && (item.kind === 'Service' && spec.selector && Object.keys(spec.selector).length || ['PodDisruptionBudget', 'NetworkPolicy'].includes(item.kind) && (spec.selector != null || spec.podSelector != null));
    if (selectsPods) {
      const selector = item.kind === 'NetworkPolicy' ? spec.podSelector : spec.selector;
      const labels = selector.matchLabels ?? (selector.matchExpressions ? {} : selector);
      const emptySelector = !Object.keys(labels).length && !(selector.matchExpressions ?? []).length;
      // Incoming links to a small focus inspect only active Pods; full/scoped views use a label index.
      const candidates = options.adjacentTo && !options.adjacentTo.has(resourceKey(item)) ? activePods ?? [] : Object.keys(labels).length ? selectorCandidates(item.namespace, labels) : resources.Pod.values();
      for (const pod of candidates) {
        if (pod.namespace === item.namespace && (emptySelector || matchesSelector(pod.labels ?? {}, selector))) {
          link(resourceKey(item), resourceKey(pod), 'selects', 'selects');
        }
      }
    }
    if (native && item.kind === 'Ingress') {
      reference(item, 'IngressClass', spec.ingressClassName, null);
      for (const tls of spec.tls ?? []) reference(item, 'Secret', tls.secretName);
      const backends = [spec.defaultBackend, ...(spec.rules ?? []).flatMap((r: any) => (r.http?.paths ?? []).map((p: any) => p.backend))];
      for (const backend of backends) reference(item, 'Service', backend?.service?.name, item.namespace, 'routes');
    }
    if (native && item.kind === 'PersistentVolumeClaim') reference(item, 'PersistentVolume', spec.volumeName ?? item.volume, null, 'binds');
    if (native && (item.kind === 'PersistentVolumeClaim' || item.kind === 'PersistentVolume')) reference(item, 'StorageClass', spec.storageClassName ?? item.storageClass, null, 'uses');
    if (native && item.kind === 'PersistentVolume') {
      reference(item, 'PersistentVolumeClaim', spec.claimRef?.name, spec.claimRef?.namespace, 'binds', true, spec.claimRef?.uid);
      for (const secret of [spec.csi?.controllerPublishSecretRef, spec.csi?.nodeStageSecretRef, spec.csi?.nodePublishSecretRef, spec.csi?.controllerExpandSecretRef, spec.csi?.nodeExpandSecretRef]) reference(item, 'Secret', secret?.name, secret?.namespace);
    }
  }
  return { items: options.adjacentTo ? new Map([...items].filter(([key]) => included.has(key))) : items, relations: [...relations.values()] };
}

export function scopeResourceGraph(graph: ResourceGraph, namespace?: string, focus?: ResourceItem, depth = 2): ResourceGraph {
  let keys: Set<string>;
  if (focus) {
    keys = new Set([resourceKey(focus)]);
    let frontier = new Set(keys);
    for (let step = 0; step < depth; step++) {
      const next = new Set<string>();
      for (const edge of graph.relations) {
        if (edge.type === 'contains' || edge.missing) continue;
        if (frontier.has(edge.source) && !keys.has(edge.target)) next.add(edge.target);
        if (frontier.has(edge.target) && !keys.has(edge.source)) next.add(edge.source);
      }
      for (const key of next) keys.add(key);
      frontier = next;
    }
  } else if (namespace && namespace !== 'all') {
    keys = new Set([...graph.items].filter(([, item]) => item.namespace === namespace || (item.kind === 'Namespace' && item.name === namespace)).map(([key]) => key));
    for (const edge of graph.relations) {
      if (edge.missing) continue;
      if (keys.has(edge.source) && !graph.items.get(edge.target)?.namespace) keys.add(edge.target);
      if (keys.has(edge.target) && !graph.items.get(edge.source)?.namespace) keys.add(edge.source);
    }
  } else keys = new Set(graph.items.keys());
  return {
    items: new Map([...graph.items].filter(([key]) => keys.has(key))),
    relations: graph.relations.filter((e) => !e.missing && keys.has(e.source) && keys.has(e.target)),
  };
}
