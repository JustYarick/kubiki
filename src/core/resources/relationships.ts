import type { ResourceItem, ResourceKind } from '../../types/k8s';
import { matchesResourceRef, resourceKey } from './identity';
import { RESOURCE_TYPES, apiVersionFor } from './resource_types';

export type RelationType = 'owns' | 'selects' | 'routes' | 'schedules' | 'uses' | 'binds' | 'contains';
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

/** Resolve API references, never infer ownership from a resource's name. */
export function buildResourceGraph(resources: Record<ResourceKind, Map<string, ResourceItem>>, options: GraphBuildOptions = {}): ResourceGraph {
  // Events describe notifications about objects, not structural relationships.
  const all = Object.values(resources).flatMap((map) => [...map.values()].filter((item) => item.kind !== 'Event'));
  const items = new Map(all.map((item) => [resourceKey(item), item]));
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
    if (!relations.has(id) && relations.size >= (options.maxEdges ?? Infinity)) throw new GraphLimitError(`This scope exceeds ${options.maxEdges} relationships. Reduce the depth or choose a smaller resource.`);
    for (const key of missing ? [] : [source, target]) if (items.has(key)) {
      included.add(key);
      if (included.size > (options.maxNodes ?? Infinity)) throw new GraphLimitError(`This scope exceeds ${options.maxNodes} resources. Reduce the depth or open a single Pod.`);
    }
    relations.set(id, { id, source, target, type, label, missing });
  };
  const reference = (from: ResourceItem, kind: string, name: string | undefined, namespace: string | null = from.namespace ?? null, type: RelationType = 'uses', reverse = false, uid?: string, apiVersion?: string) => {
    if (!name || name === '-' || kind === 'Event') return;
    const builtin = RESOURCE_TYPES.find((resource) => resource.kind === kind);
    const reference = { kind, name, namespace: namespace ?? undefined, uid, apiVersion: apiVersion ?? (builtin ? apiVersionFor(builtin) : '') };
    const key = resourceKey(reference);
    const target = uid ? byUid.get(uid) : items.get(key);
    // A recreated object with the same name is not the owner referenced by the old UID.
    const valid = target && matchesResourceRef(target, reference);
    const targetKey = valid ? resourceKey(target) : key;
    const missing = valid ? undefined : reference;
    link(reverse ? targetKey : resourceKey(from), reverse ? resourceKey(from) : targetKey, type, type, missing);
  };

  for (const item of all) {
    const raw = item.raw ?? { metadata: item.metadata, spec: item.spec, status: item.statusRaw };
    const spec: any = raw.spec ?? {};
    const metadata: any = raw.metadata ?? {};
    for (const owner of metadata.ownerReferences ?? []) {
      reference(item, owner.kind, owner.name, item.namespace, 'owns', true, owner.uid, owner.apiVersion);
    }
    if (item.namespace) reference(item, 'Namespace', item.namespace, null, 'contains', true);
    if (item.kind === 'Pod') {
      reference(item, 'Node', spec.nodeName ?? item.node, null, 'schedules', true);
      for (const secret of spec.imagePullSecrets ?? []) reference(item, 'Secret', secret.name);
      for (const volume of spec.volumes ?? []) {
        reference(item, 'PersistentVolumeClaim', volume.persistentVolumeClaim?.claimName);
        reference(item, 'ConfigMap', volume.configMap?.name);
        reference(item, 'Secret', volume.secret?.secretName);
        for (const source of volume.projected?.sources ?? []) {
          reference(item, 'ConfigMap', source.configMap?.name);
          reference(item, 'Secret', source.secret?.name);
        }
      }
      for (const container of [...(spec.containers ?? []), ...(spec.initContainers ?? []), ...(spec.ephemeralContainers ?? [])]) {
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
    if (item.kind === 'Service' && spec.selector && Object.keys(spec.selector).length) {
      // Incoming links to a small focus inspect only active Pods; full/scoped views use a label index.
      const candidates = options.adjacentTo && !options.adjacentTo.has(resourceKey(item)) ? activePods ?? [] : selectorCandidates(item.namespace, spec.selector);
      for (const pod of candidates) {
        if (pod.namespace === item.namespace && matchesSelector(pod.labels ?? {}, spec.selector)) {
          link(resourceKey(item), resourceKey(pod), 'selects', 'selects');
        }
      }
    }
    if (item.kind === 'Ingress') {
      const backends = [spec.defaultBackend, ...(spec.rules ?? []).flatMap((r: any) => (r.http?.paths ?? []).map((p: any) => p.backend))];
      for (const backend of backends) reference(item, 'Service', backend?.service?.name, item.namespace, 'routes');
    }
    if (item.kind === 'PersistentVolumeClaim') reference(item, 'PersistentVolume', spec.volumeName ?? item.volume, null, 'binds');
    if (item.kind === 'PersistentVolumeClaim' || item.kind === 'PersistentVolume') reference(item, 'StorageClass', spec.storageClassName ?? item.storageClass, null, 'uses');
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
