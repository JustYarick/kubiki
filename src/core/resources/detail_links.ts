import type { ResourceItem, ResourceKind } from '../../types/k8s';
import { matchesSelector } from './relationships';
import { parseApiVersion, RESOURCE_TYPES } from './resource_types';

export type ResourceMap = Partial<Record<ResourceKind, Map<string, ResourceItem>>>;

const WORKLOAD_KINDS: ResourceKind[] = ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'ReplicationController'];

function mapOf(resources: ResourceMap, kind: string): ResourceItem[] {
  return [...(resources[kind as ResourceKind]?.values() ?? [])];
}

/** Exact object lookup by kind and name inside a namespace. */
export function resourceByRef(
  resources: ResourceMap,
  ref: { kind?: string; name?: string; namespace?: string; group?: string; apiVersion?: string } | undefined,
  options: { kinds?: ResourceKind[]; namespace?: string } = {},
): ResourceItem | undefined {
  if (!ref?.name) return undefined;
  const namespace = ref.namespace ?? options.namespace;
  const kinds = ref.kind ? [ref.kind as ResourceKind] : options.kinds ?? [];
  for (const kind of kinds) {
    const group = ref.group ?? (ref.apiVersion ? parseApiVersion(ref.apiVersion).group : undefined);
    const bucket = group === undefined || RESOURCE_TYPES.some(type => type.kind === kind && type.group === group) ? kind : `custom:${group}/${kind}`;
    const match = mapOf(resources, bucket).find(item =>
      item.name === ref.name && (namespace ? item.namespace === namespace : true));
    if (match) return match;
  }
  return undefined;
}

/** Same lookup, but the kind is unknown: any workload with that name is accepted. */
export function workloadByName(resources: ResourceMap, name: string, namespace?: string): ResourceItem | undefined {
  return WORKLOAD_KINDS
    .map(kind => mapOf(resources, kind).find(item => item.name === name && (!namespace || item.namespace === namespace)))
    .find(Boolean);
}

/** Pods of a namespace matching a label selector (matchLabels / matchExpressions). */
export function podsForSelector(resources: ResourceMap, selector: any, namespace?: string): ResourceItem[] {
  const pods = mapOf(resources, 'Pod').filter(pod => !namespace || pod.namespace === namespace);
  if (!selector) return [];
  const labels = selector.matchLabels ?? (selector.matchExpressions ? {} : selector);
  const expressions = selector.matchExpressions ?? [];
  if (!Object.keys(labels).length && !expressions.length) return pods;
  return pods.filter(pod => matchesSelector(pod.labels ?? pod.raw?.metadata?.labels ?? {}, selector));
}

/** The workload that owns a pod, following the ReplicaSet → Deployment chain. */
export function ownerWorkload(resources: ResourceMap, pod: ResourceItem): ResourceItem | undefined {
  const owners = pod.raw?.metadata?.ownerReferences ?? [];
  for (const owner of owners) {
    if (owner.kind === 'ReplicaSet') {
      const replicaSet = mapOf(resources, 'ReplicaSet').find(rs => rs.uid === owner.uid || rs.name === owner.name);
      const deployment = replicaSet && (replicaSet.raw?.metadata?.ownerReferences ?? []).find((ref: any) => ref.kind === 'Deployment');
      if (deployment) {
        const target = mapOf(resources, 'Deployment').find(d => d.uid === deployment.uid || d.name === deployment.name);
        if (target) return target;
      }
      if (replicaSet) return replicaSet;
      continue;
    }
    const target = mapOf(resources, owner.kind).find(item => item.uid === owner.uid || item.name === owner.name);
    if (target) return target;
  }
  return undefined;
}

/** Workloads behind a set of pods, deduplicated and stable. */
export function workloadsForPods(resources: ResourceMap, pods: ResourceItem[]): ResourceItem[] {
  const found = new Map<string, ResourceItem>();
  for (const pod of pods) {
    const workload = ownerWorkload(resources, pod);
    if (workload) found.set(workload.uid, workload);
  }
  return [...found.values()];
}

/** Service that owns an EndpointSlice (kubernetes.io/service-name label). */
export function serviceForEndpointSlice(resources: ResourceMap, slice: ResourceItem): ResourceItem | undefined {
  const name = slice.labels?.['kubernetes.io/service-name'] ?? slice.raw?.metadata?.labels?.['kubernetes.io/service-name'];
  if (!name) return undefined;
  return mapOf(resources, 'Service').find(service => service.name === name && service.namespace === slice.namespace);
}

/** Service that owns a legacy Endpoints object. */
export function serviceForEndpoints(resources: ResourceMap, endpoints: ResourceItem): ResourceItem | undefined {
  return mapOf(resources, 'Service').find(service => service.name === endpoints.name && service.namespace === endpoints.namespace);
}
