import type { ResourceItem, ResourceKind } from '../types/k8s';
import { RESOURCE_TYPES } from '../core/resources/resource_types';
import { resourceKey } from '../core/resources/identity';
import { customResourceType, resourceBucket } from '../core/resources/custom_resource_types';
import { namespaceNames, inNamespaceScope } from '../core/resources/namespace_scope';
import { helmResource } from '../core/resources/helm';
import { useResourceStore } from '../state/resource_store';
import type { K8sProvider } from './k8s_provider';

export interface SearchInventory {
  items: ResourceItem[];
  completed: number;
  total: number;
  errors: string[];
  loading: boolean;
  completedBuckets?: string[];
}
export interface SearchInventoryOptions {
  liveKinds?: ReadonlySet<string>;
  zeroKinds?: ReadonlySet<string>;
  completedBuckets?: ReadonlySet<string>;
  throttleMs?: number;
}
type Reader = Pick<K8sProvider, 'getResources' | 'getCustomResources' | 'getHelmInventory'> & {
  getCustomSearchInventory?: K8sProvider['getCustomSearchInventory'];
};

const projectedSearchItems = new WeakSet<ResourceItem>();
export const isSearchProjectedItem = (item: ResourceItem) => projectedSearchItems.has(item);

const TIER1_KINDS = new Set([
  'Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'Service', 'Ingress',
  'ConfigMap', 'Secret', 'Job', 'CronJob', 'PersistentVolumeClaim', 'Node',
  'Namespace', 'ReplicaSet',
]);
const TIER3_KINDS = new Set([
  'Event', 'EndpointSlice', 'Endpoints', 'Lease', 'ReplicationController', 'ControllerRevision',
]);
const PROJECTED_SEARCH_KINDS = new Set([
  'Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'ReplicationController',
  'Job', 'CronJob', 'Node', 'Service', 'Ingress', 'PersistentVolumeClaim',
  'PersistentVolume', 'Event', 'Namespace',
]);

function kindPriority(kind: string): number {
  if (kind === 'CustomResourceDefinition') return 0;
  if (TIER1_KINDS.has(kind)) return 1;
  if (TIER3_KINDS.has(kind)) return 3;
  return 2;
}

function searchReadOptions(kind: string) {
  if (kind === 'CustomResourceDefinition') return { priority: 'low' as const, lane: 'search' as const };
  if (PROJECTED_SEARCH_KINDS.has(kind)) return { projection: 'search' as const, priority: 'low' as const, lane: 'search' as const };
  return { metadataOnly: true, priority: 'low' as const, lane: 'search' as const };
}

/** A private, on-demand inventory; searching never replaces an active table/watch snapshot. */
export async function loadSearchInventory(
  reader: Reader,
  context: string,
  scope: string,
  seed: ResourceItem[],
  available: string[] | null,
  signal: AbortSignal,
  publish: (state: SearchInventory) => void,
  options?: SearchInventoryOptions,
): Promise<SearchInventory> {
  const found = new Map(seed.filter(item => inNamespaceScope(scope, item.namespace)).map(item => [resourceKey(item), item]));
  const errors: string[] = [];
  const jobs: { label: string; bucket: string; tier: number; read: () => Promise<ResourceItem[]> }[] = [];
  const queuedOrDoneBuckets = new Set<string>(options?.completedBuckets);
  const doneBuckets = new Set<string>(options?.completedBuckets);
  const liveKinds = options?.liveKinds;
  const zeroKinds = options?.zeroKinds;
  const useBatchCustom = typeof reader.getCustomSearchInventory === 'function';
  const customs = new Set<string>();
  let completed = doneBuckets.size;
  const namespaces = namespaceNames(scope);

  const enqueueJob = (job: { label: string; bucket: string; tier: number; read: () => Promise<ResourceItem[]> }) => {
    if (queuedOrDoneBuckets.has(job.bucket)) return;
    queuedOrDoneBuckets.add(job.bucket);
    jobs.push(job);
  };

  const addCustoms = (definitions: ResourceItem[]) => {
    if (useBatchCustom) return;
    for (const definition of definitions) {
      const type = customResourceType(definition);
      if (!type || customs.has(type.key) || type.namespaced && namespaces?.length === 0) continue;
      customs.add(type.key);
      const bucket = resourceBucket({ kind: type.kind, apiVersion: `${type.group}/${type.version}` });
      enqueueJob({
        label: `${type.kind} (${type.group})`,
        bucket,
        tier: 2,
        read: async () => {
          const items = await reader.getCustomResources(
            context,
            type.name,
            type.uid,
            type.namespaced && scope !== 'all' ? scope : null,
            signal,
            {
              projection: 'search',
              priority: 'low',
              lane: 'search',
              onPartialError: failures => {
                errors.push(`${type.kind}: partial (${failures.map(f => f.namespace).join(', ')} unavailable)`);
              },
            },
          );
          for (const entry of items) projectedSearchItems.add(entry);
          return items;
        },
      });
    }
  };

  const definitions = seed.filter(item => item.kind === 'CustomResourceDefinition');
  // Read CRDs and Tier 1 workloads before high-volume infrastructure collections.
  const types = [...RESOURCE_TYPES].sort((a, b) => kindPriority(a.kind) - kindPriority(b.kind));
  for (const type of types) {
    if (available && !available.includes(type.kind) || type.namespaced && namespaces?.length === 0) continue;
    if (liveKinds?.has(type.kind) || zeroKinds?.has(type.kind)) {
      if (!doneBuckets.has(type.kind)) {
        doneBuckets.add(type.kind);
        completed++;
      }
      queuedOrDoneBuckets.add(type.kind);
      if (type.kind === 'CustomResourceDefinition') addCustoms(definitions);
      continue;
    }
    const readOptions = searchReadOptions(type.kind);
    enqueueJob({
      label: type.kind,
      bucket: type.kind,
      tier: kindPriority(type.kind),
      read: async () => {
        try {
          const items = await reader.getResources(
            context,
            type.kind as ResourceKind,
            type.namespaced ? scope : 'all',
            signal,
            {
              ...readOptions,
              onPartialError: failures => {
                errors.push(`${type.kind}: partial (${failures.map(f => f.namespace).join(', ')} unavailable)`);
              },
            },
          );
          if (type.kind === 'CustomResourceDefinition') {
            if (!signal.aborted) addCustoms(items);
          } else {
            for (const entry of items) projectedSearchItems.add(entry);
          }
          return items;
        } catch (error) {
          if (!signal.aborted && type.kind === 'CustomResourceDefinition') addCustoms(definitions);
          throw error;
        }
      },
    });
  }
  if (useBatchCustom && !queuedOrDoneBuckets.has('custom:__batch__')) {
    enqueueJob({
      label: 'Custom resources',
      bucket: 'custom:__batch__',
      tier: 2,
      read: async () => {
        const result = await reader.getCustomSearchInventory!(context, scope === 'all' ? null : scope, signal);
        for (const entry of result.items) projectedSearchItems.add(entry);
        if (result.errors.length) errors.push(...result.errors);
        return result.items;
      },
    });
  } else if (!jobs.some(job => job.bucket === 'CustomResourceDefinition')) {
    addCustoms(definitions);
  }
  if (namespaces?.length !== 0) {
    enqueueJob({
      label: 'Helm releases',
      bucket: 'HelmRelease',
      tier: 3,
      read: async () => {
        const { loadPartialHelmInventory } = await import('./helm_inventory');
        const fallback = [...useResourceStore.getState().resources.Namespace.values()].map(ns => ns.name);
        const result = await loadPartialHelmInventory(
          (ctx, ns, sig) => reader.getHelmInventory(ctx, ns, sig),
          context,
          scope === 'all' ? null : scope,
          signal,
          fallback,
        );
        if (result.partialErrors.length) {
          errors.push(`Helm releases: partial (${result.partialErrors.map(e => e.scope).join(', ')} unavailable)`);
        }
        return result.items.map(release => helmResource(context, release));
      },
    });
  }
  jobs.sort((a, b) => a.tier - b.tier);

  const totalCollections = completed + jobs.length;
  const snapshot = (loading: boolean): SearchInventory => ({
    items: [...found.values()],
    completed,
    total: Math.max(totalCollections, completed + (jobs.length - cursor)),
    errors: [...errors],
    loading,
    completedBuckets: [...doneBuckets],
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const throttleMs = options?.throttleMs ?? 150;
  const update = () => { if (!timer) timer = setTimeout(() => { timer = undefined; if (!signal.aborted) publish(snapshot(true)); }, throttleMs); };
  let cursor = 0;
  const run = async () => {
    while (!signal.aborted) {
      if (cursor >= jobs.length) return;
      const job = jobs[cursor++];
      try {
        const items = await job.read();
        if (signal.aborted) return;
        if (job.bucket === 'custom:__batch__') {
          for (const [key, item] of found) {
            if (resourceBucket(item).startsWith('custom:')) found.delete(key);
          }
        } else {
          for (const [key, item] of found) if (resourceBucket(item) === job.bucket) found.delete(key);
        }
        for (const item of items) found.set(resourceKey(item), item);
        doneBuckets.add(job.bucket);
      } catch (error) {
        if (signal.aborted) return;
        errors.push(`${job.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
      completed++; update();
    }
  };
  publish(snapshot(true));
  await Promise.all(Array.from({ length: 16 }, run));
  clearTimeout(timer);
  return snapshot(false);
}
