import { useEffect, useRef, useState } from 'react';
import { useClusterStore } from '../state/cluster_store';
import { useResourceStore } from '../state/resource_store';
import { useUiStore } from '../state/ui_store';
import { resourceBucket, type CustomResourceType } from '../core/resources/custom_resource_types';
import { inNamespaceScope, namespaceScopeCovers } from '../core/resources/namespace_scope';
import type { ResourceItem } from '../types/k8s';
import { k8s } from './k8s_provider';
import { ResourceWatchSession } from './resource_watch_session';
import { ReadSubscriptions } from './read_subscriptions';

interface CustomStream { resourceKey: string; session: ResourceWatchSession; listeners: Set<(loading: boolean) => void>; loading: boolean }
const streams = new Map<string, CustomStream>();
export function isCustomResourceWatched(context: string | null, resourceKey: string): boolean {
  return [...streams.values()].some(stream => stream.session.context === context && stream.resourceKey === resourceKey);
}
// Browser mode has no native watch transport, but must not freeze after its first list.
const snapshots = new ReadSubscriptions<ResourceItem[]>(async (key, signal) => {
  const {context, type, scope} = JSON.parse(key) as {context:string;type:CustomResourceType;scope:string};
  const items = await k8s.getCustomResources(context, type.name, type.uid, type.namespaced && scope !== 'all' ? scope : null, signal);
  if (items.some(item => resourceBucket(item) !== type.key)) throw new Error('Custom resource list does not match this CRD');
  return items;
});

export function clearCustomResourcesCache(refreshActive = false): void {
  snapshots.clearCache({ refreshActive });
  if (refreshActive) {
    for (const stream of streams.values()) {
      void stream.session.refresh(stream.resourceKey).catch(() => {});
    }
  }
}

function retainOtherNamespaces(type: CustomResourceType, scope: string, items: ResourceItem[]) {
  const retained = type.namespaced && scope !== 'all'
    ? [...(useResourceStore.getState().resources[type.key]?.values() ?? [])].filter(item => !inNamespaceScope(scope, item.namespace)) : [];
  return [...retained, ...items];
}
function subscribeWatch(key: string, context: string, type: CustomResourceType, scope: string, receive: (loading: boolean) => void) {
  let entry = streams.get(key);
  if (!entry) {
    const listeners = new Set<(loading: boolean) => void>();
    const session = new ResourceWatchSession(context, {
      managesInitialSyncTimeout:true,
      watchResources:(query, onBatch, signal) => k8s.watchCustomResources(query, type, onBatch, signal),
    }, (kind, update) => {
      if (streams.get(key)?.session !== session || useClusterStore.getState().currentContext !== context) return;
      if (update.snapshot) update = {...update, snapshot:retainOtherNamespaces(type, scope, update.snapshot)};
      useResourceStore.getState().applyWatchCommit(kind, update);
      const current = streams.get(key)!;
      current.loading = ['connecting','syncing'].includes(update.state.phase);
      for (const listener of current.listeners) listener(current.loading);
    }, scope, new Set(), (query, allowPartial) => {
      if (useUiStore.getState().resourceCacheMode === 'always-fresh') return undefined;
      const state = useResourceStore.getState();
      const snapshot = state.watchStates[type.key];
      if (!snapshot || snapshot.query.context !== query.context || !allowPartial && (!snapshot.hasSnapshot || !namespaceScopeCovers(snapshot.query.namespace ?? 'all', query.namespace ?? 'all'))) return;
      return [...(state.resources[type.key]?.values() ?? [])].filter(item => inNamespaceScope(query.namespace ?? 'all', item.namespace));
    }, type);
    entry = {resourceKey:type.key, session, listeners, loading:true};
    streams.set(key, entry);
    void session.start([type.key]);
  }
  const current = entry;
  current.listeners.add(receive); receive(current.loading);
  return () => {
    current.listeners.delete(receive);
    if (!current.listeners.size && streams.get(key) === current) {
      void current.session.setKinds([]);
      streams.delete(key);
      current.session.stop();
    }
  };
}

export function useCustomResources(type?: CustomResourceType, namespace?: string) {
  const context = useClusterStore(state => state.currentContext);
  const selectedNamespace = useClusterStore(state => state.selectedNamespace);
  const scope = type?.namespaced ? namespace ?? selectedNamespace : 'all';
  const key = type && context ? JSON.stringify({context,type,scope}) : '';
  const [state, setState] = useState<{key:string; loading:boolean; fromCache?:boolean; updatedAt?:number}>({key:'', loading:false});
  const typeRef = useRef(type); typeRef.current = type;
  useEffect(() => {
    const definition = typeRef.current;
    if (!key || !context || !definition) return;
    if (k8s.supportsResourceWatch) return subscribeWatch(key, context, definition, scope, loading => setState({key, loading}));
    let previous: ResourceItem[] | undefined;
    return snapshots.subscribe(key, snapshot => {
      if (useClusterStore.getState().currentContext !== context) return;
      const store = useResourceStore.getState();
      if (snapshot.data && snapshot.data !== previous) {
        previous = snapshot.data;
        store.setResourcesForKind(definition.key, retainOtherNamespaces(definition, scope, snapshot.data));
      } else if (!snapshot.data && previous === undefined && useUiStore.getState().resourceCacheMode === 'always-fresh') {
        store.setResourcesForKind(definition.key, retainOtherNamespaces(definition, scope, []));
      }
      store.setLoadError(definition.key, snapshot.error ?? null);
      setState({key, loading: snapshot.loading, fromCache: snapshot.fromCache, updatedAt: snapshot.updated});
    });
  }, [key, context, scope]);
  return {
    loading: !!key && (state.key !== key || state.loading),
    fromCache: !!key && state.key === key && Boolean(state.fromCache),
    updatedAt: !!key && state.key === key ? state.updatedAt : undefined,
    refresh: () => {
      const stream = streams.get(key);
      if (stream && type) void stream.session.refresh(type.key).catch(() => {});
      else if (key) snapshots.refresh(key, true);
    },
    discardStale: () => {
      if (!type) return;
      const stream = streams.get(key);
      stream?.session.clearSnapshot(type.key);
      if (key) snapshots.discardStale(key);
      useResourceStore.getState().discardStaleResources(type.key);
    },
  };
}
