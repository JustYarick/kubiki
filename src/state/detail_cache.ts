import { useMemo } from 'react';
import { create } from 'zustand';
import type { ResourceItem, ResourceKind } from '../types/k8s';
import { resourceKey } from '../core/resources/identity';
import { useClusterStore } from './cluster_store';
import { useResourceStore } from './resource_store';

const MAX_CACHE_ITEMS = 96;
const MAX_EVENT_ENTRIES = 16;
export const detailReadKey = (kind: string, name: string, namespace?: string) => JSON.stringify([kind, namespace ?? null, name]);

export function referenceAvailabilityNote(
  kind: string,
  name: string,
  namespace: string | undefined,
  target: ResourceItem | undefined,
  reads: ReadonlyMap<string, 'notFound' | 'unavailable'> | undefined,
): 'Exists · contents unavailable' | 'Not found' | 'Existence unknown · access unavailable' | undefined {
  if (target) return kind === 'Secret' && target.readProjection === 'metadata' ? 'Exists · contents unavailable' : undefined;
  const observed = reads?.get(detailReadKey(kind, name, namespace));
  if (observed === 'notFound') return 'Not found';
  if (observed === 'unavailable') return 'Existence unknown · access unavailable';
  return undefined;
}

export function useDetailReadStates(): ReadonlyMap<string, 'notFound' | 'unavailable'> | undefined {
  const currentContext = useClusterStore((s) => s.currentContext);
  const cacheContext = useDetailCache((s) => s.context);
  const readStates = useDetailCache((s) => s.readStates);
  return currentContext && cacheContext === currentContext ? readStates : undefined;
}

interface DetailCacheState {
  context: string | null;
  items: Map<string, ResourceItem>;
  byKind: Partial<Record<ResourceKind, Map<string, ResourceItem>>>;
  eventsByUid: Map<string, ResourceItem[]>;
  readStates: Map<string, 'notFound' | 'unavailable'>;
  setReadState: (context: string, key: string, state: 'notFound' | 'unavailable') => void;
  upsert: (context: string, item: ResourceItem) => void;
  upsertMany: (context: string, list: ResourceItem[]) => void;
  setEvents: (context: string, uid: string, events: ResourceItem[]) => void;
  clear: (context?: string) => void;
}

function rebuildByKind(items: Map<string, ResourceItem>): Partial<Record<ResourceKind, Map<string, ResourceItem>>> {
  const byKind: Partial<Record<ResourceKind, Map<string, ResourceItem>>> = {};
  for (const item of items.values()) {
    let map = byKind[item.kind];
    if (!map) {
      map = new Map();
      byKind[item.kind] = map;
    }
    map.set(item.uid || item.name, item);
  }
  return byKind;
}

export const useDetailCache = create<DetailCacheState>((set) => ({
  context: null,
  items: new Map(),
  byKind: {},
  eventsByUid: new Map(),
  readStates: new Map(),
  setReadState: (context, key, value) => set(state => {
    const readStates = state.context === context ? new Map(state.readStates) : new Map();
    readStates.delete(key); readStates.set(key, value);
    while (readStates.size > MAX_CACHE_ITEMS) readStates.delete(readStates.keys().next().value!);
    return { context, readStates, ...(state.context === context ? {} : { items: new Map(), byKind: {}, eventsByUid: new Map() }) };
  }),

  upsert: (context, item) => set((state) => {
    const items = state.context === context ? new Map(state.items) : new Map<string, ResourceItem>();
    const eventsByUid = state.context === context ? state.eventsByUid : new Map<string, ResourceItem[]>();
    const key = `${context}/${resourceKey(item)}`;
    items.delete(key);
    items.set(key, item);
    while (items.size > MAX_CACHE_ITEMS) items.delete(items.keys().next().value!);
    const readStates = state.context === context ? new Map(state.readStates) : new Map();
    readStates.delete(detailReadKey(item.kind, item.name, item.namespace));
    return { context, items, byKind: rebuildByKind(items), eventsByUid, readStates };
  }),

  upsertMany: (context, list) => {
    if (!list.length) return;
    set((state) => {
      const items = state.context === context ? new Map(state.items) : new Map<string, ResourceItem>();
      const eventsByUid = state.context === context ? state.eventsByUid : new Map<string, ResourceItem[]>();
      for (const item of list) {
        const key = `${context}/${resourceKey(item)}`;
        items.delete(key);
        items.set(key, item);
      }
      while (items.size > MAX_CACHE_ITEMS) items.delete(items.keys().next().value!);
      const readStates = state.context === context ? new Map(state.readStates) : new Map();
      for (const item of list) readStates.delete(detailReadKey(item.kind, item.name, item.namespace));
      return { context, items, byKind: rebuildByKind(items), eventsByUid, readStates };
    });
  },

  setEvents: (context, uid, events) => set((state) => {
    const items = state.context === context ? state.items : new Map<string, ResourceItem>();
    const byKind = state.context === context ? state.byKind : {};
    const eventsByUid = state.context === context ? new Map(state.eventsByUid) : new Map<string, ResourceItem[]>();
    const key = `${context}/${uid}`;
    eventsByUid.delete(key);
    eventsByUid.set(key, events);
    while (eventsByUid.size > MAX_EVENT_ENTRIES) eventsByUid.delete(eventsByUid.keys().next().value!);
    return { context, items, byKind, eventsByUid, readStates: state.context === context ? state.readStates : new Map() };
  }),

  clear: (context) => set(() => ({
    context: context ?? null,
    items: new Map(),
    byKind: {},
    eventsByUid: new Map(),
    readStates: new Map(),
  })),
}));

/** Merge live watch snapshots with targeted detail-cache items (live watch items always take precedence). */
export function useMergedDetailResources(): Record<ResourceKind, Map<string, ResourceItem>> {
  const resources = useResourceStore((s) => s.resources);
  const currentContext = useClusterStore((s) => s.currentContext);
  const cacheContext = useDetailCache((s) => s.context);
  const byKind = useDetailCache((s) => s.byKind);

  return useMemo(() => {
    if (!currentContext || cacheContext !== currentContext) return resources;
    const extraKinds = Object.keys(byKind) as ResourceKind[];
    if (!extraKinds.length) return resources;
    const merged = { ...resources };
    for (const kind of extraKinds) {
      const cached = byKind[kind];
      if (!cached?.size) continue;
      const live = resources[kind];
      if (!live?.size) {
        merged[kind] = cached;
        continue;
      }
      const next = new Map(cached);
      for (const [uid, item] of live) {
        const existing = next.get(uid);
        // Never overwrite a full on-demand Secret/ConfigMap copy with a summary watch row.
        if (existing && !existing.readProjection && item.readProjection) {
          const existingRv = existing.raw?.metadata?.resourceVersion;
          const liveRv = item.raw?.metadata?.resourceVersion;
          if (!existingRv || !liveRv || existingRv === liveRv) continue;
        }
        next.set(uid, item);
      }
      merged[kind] = next;
    }
    return merged;
  }, [resources, currentContext, cacheContext, byKind]);
}

/** Combine watched Event items with targeted per-UID Event fetches for the inspected object. */
export function useMergedDetailEvents(uid: string): Iterable<ResourceItem> {
  const eventsMap = useResourceStore((s) => s.resources.Event);
  const currentContext = useClusterStore((s) => s.currentContext);
  const cacheContext = useDetailCache((s) => s.context);
  const eventsByUid = useDetailCache((s) => s.eventsByUid);

  return useMemo(() => {
    const targeted = currentContext && cacheContext === currentContext
      ? eventsByUid.get(`${currentContext}/${uid}`)
      : undefined;
    if (!targeted?.length) return eventsMap.values();
    if (!eventsMap.size) return targeted;
    const combined = new Map<string, ResourceItem>();
    for (const ev of targeted) combined.set(ev.uid, ev);
    for (const ev of eventsMap.values()) combined.set(ev.uid, ev);
    return combined.values();
  }, [eventsMap, currentContext, cacheContext, eventsByUid, uid]);
}
