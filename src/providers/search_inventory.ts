import type { ResourceItem, ResourceKind } from '../types/k8s';
import { RESOURCE_TYPES } from '../core/resources/resource_types';
import { resourceKey } from '../core/resources/identity';
import { customResourceType, resourceBucket } from '../core/resources/custom_resource_types';
import { namespaceNames, inNamespaceScope } from '../core/resources/namespace_scope';
import { helmResource } from '../core/resources/helm';
import type { K8sProvider } from './k8s_provider';

export interface SearchInventory { items: ResourceItem[]; completed: number; total: number; errors: string[]; loading: boolean }
type Reader = Pick<K8sProvider, 'getResources' | 'getCustomResources' | 'getHelmInventory'>;

/** A private, on-demand inventory; searching never replaces an active table/watch snapshot. */
export async function loadSearchInventory(reader: Reader, context: string, scope: string, seed: ResourceItem[], available: string[] | null, signal: AbortSignal, publish: (state: SearchInventory) => void): Promise<SearchInventory> {
  const found = new Map(seed.filter(item => inNamespaceScope(scope, item.namespace)).map(item => [resourceKey(item), item]));
  const errors: string[] = [];
  const jobs: { label: string; bucket: string; read: () => Promise<ResourceItem[]> }[] = [];
  const customs = new Set<string>();
  let completed = 0;
  const namespaces = namespaceNames(scope);
  const addCustoms = (definitions: ResourceItem[]) => {
    for (const definition of definitions) {
      const type = customResourceType(definition);
      if (!type || customs.has(type.key) || type.namespaced && namespaces?.length === 0) continue;
      customs.add(type.key);
      jobs.push({ label: `${type.kind} (${type.group})`, bucket: resourceBucket({ kind: type.kind, apiVersion: `${type.group}/${type.version}` }), read: () => reader.getCustomResources(context, type.name, type.uid, type.namespaced && scope !== 'all' ? scope : null, signal) });
    }
  };
  const definitions = seed.filter(item => item.kind === 'CustomResourceDefinition');
  // Read CRDs early; discovered custom collections join the same bounded queue.
  const types = [...RESOURCE_TYPES].sort((a, b) => Number(b.kind === 'CustomResourceDefinition') - Number(a.kind === 'CustomResourceDefinition'));
  for (const type of types) {
    if (available && !available.includes(type.kind) || type.namespaced && namespaces?.length === 0) continue;
    jobs.push({ label: type.kind, bucket: type.kind, read: async () => {
      try {
        const items = await reader.getResources(context, type.kind as ResourceKind, type.namespaced ? scope : 'all', signal);
        if (!signal.aborted && type.kind === 'CustomResourceDefinition') addCustoms(items);
        return items;
      } catch (error) { if (!signal.aborted && type.kind === 'CustomResourceDefinition') addCustoms(definitions); throw error; }
    } });
  }
  if (!jobs.some(job => job.bucket === 'CustomResourceDefinition')) addCustoms(definitions);
  if (namespaces?.length !== 0) jobs.push({ label: 'Helm releases', bucket: 'HelmRelease', read: async () => (await Promise.all((namespaces ?? [null]).map(namespace => reader.getHelmInventory(context, namespace, signal)))).flat().map(release => helmResource(context, release)) });
  const snapshot = (loading: boolean): SearchInventory => ({ items: [...found.values()], completed, total: jobs.length, errors: [...errors], loading });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => { if (!timer) timer = setTimeout(() => { timer = undefined; if (!signal.aborted) publish(snapshot(true)); }, 100); };
  let cursor = 0;
  const run = async () => {
    while (!signal.aborted) {
      if (cursor >= jobs.length) return;
      const job = jobs[cursor++];
      try {
        const items = await job.read();
        if (signal.aborted) return;
        for (const [key, item] of found) if (resourceBucket(item) === job.bucket) found.delete(key);
        for (const item of items) found.set(resourceKey(item), item);
      } catch (error) {
        if (signal.aborted) return;
        errors.push(`${job.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
      completed++; update();
    }
  };
  publish(snapshot(true));
  await Promise.all(Array.from({ length: 4 }, run));
  clearTimeout(timer);
  return snapshot(false);
}
