import { inNamespaceScope } from '../core/resources/namespace_scope';
import { useEffect, useState } from 'react';
import { k8s } from './k8s_provider';
import { useClusterStore } from '../state/cluster_store';
import { useResourceStore } from '../state/resource_store';
import { helmResource } from '../core/resources/helm';
import type { ResourceItem } from '../types/k8s';

const cache = new Map<string, { at: number; items: ResourceItem[] }>();
const pending = new Map<string, Promise<ResourceItem[]>>();
let generation = 0;
const listeners = new Set<() => void>();
export function subscribeHelmChanges(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function invalidateHelmGraphs() { generation++; cache.clear(); pending.clear(); for (const listener of listeners) listener(); }
export async function loadHelmGraph(context: string, namespace: string): Promise<ResourceItem[]> {
  const key = JSON.stringify([context, namespace]);
  const previous = cache.get(key);
  if (previous && Date.now() - previous.at < 30000) return previous.items;
  const running = pending.get(key); if (running) return running;
  const request = (async () => {
    const requestedGeneration = generation;
    const items: ResourceItem[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await k8s.getHelmReleases(context, namespace === 'all' ? null : namespace, offset);
      items.push(...page.items.map(release => helmResource(context, release)));
      if (!page.has_more) break;
    }
    if (requestedGeneration === generation) cache.set(key, { at: Date.now(), items });
    // Bound retained namespace snapshots; release documents are never cached here.
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
    return items;
  })();
  pending.set(key, request);
  try { return await request; } finally { if (pending.get(key) === request) pending.delete(key); }
}

export function useHelmGraph(namespace: string | undefined, enabled: boolean) {
  const [revision, refresh] = useState(0);
  useEffect(() => { const listener = () => refresh(value => value + 1); listeners.add(listener); return () => { listeners.delete(listener); }; }, []);
  const context = useClusterStore(state => state.currentContext);
  const key = enabled && context && namespace ? JSON.stringify([context, namespace, revision]) : '';
  const [state, setState] = useState({ key: '', loading: false, error: '' });
  useEffect(() => {
    if (!key || !context || !namespace) return;
    let active = true; const requestedGeneration = generation; setState({ key, loading: true, error: '' });
    void loadHelmGraph(context, namespace).then(items => {
      if (!active || requestedGeneration !== generation || useClusterStore.getState().currentContext !== context) return;
      // Keep independently opened namespaces available in split panes.
      const retained = [...useResourceStore.getState().resources.HelmRelease.values()].filter(item => item.raw?.context === context && !inNamespaceScope(namespace, item.namespace));
      useResourceStore.getState().setResourcesForKind('HelmRelease', [...retained.slice(-1750), ...items]);
      setState({ key, loading: false, error: '' });
    }, error => { if (active && requestedGeneration === generation && useClusterStore.getState().currentContext === context) { useResourceStore.getState().setResourcesForKind('HelmRelease', [...useResourceStore.getState().resources.HelmRelease.values()].filter(item => item.raw?.context === context && !inNamespaceScope(namespace, item.namespace))); setState({ key, loading: false, error: error instanceof Error ? error.message : String(error) }); } });
    return () => { active = false; };
  }, [key, context, namespace]);
  return !key ? { loading: false, error: '' } : state.key === key ? state : { loading: true, error: '' };
}
