import { useEffect, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { k8s } from '../providers/k8s_provider';
import { useClusterStore } from '../state/cluster_store';
import { useDetailCache } from '../state/detail_cache';
import type { ResourceItem } from '../types/k8s';

/** Watch summaries omit CRD schemas and Secret/ConfigMap payloads; load the full object on demand before editing or viewing. */
export const needsFullManifest = (item: ResourceItem) =>
  !k8s.demo && (
    item.kind === 'CustomResourceDefinition'
    || item.readProjection === 'summary'
    || item.readProjection === 'metadata'
  );

function cachedFullManifest(context: string | null, item: ResourceItem): ResourceItem | undefined {
  if (!context) return undefined;
  const cache = useDetailCache.getState();
  if (cache.context !== context) return undefined;
  const cached = cache.byKind[item.kind]?.get(item.uid);
  if (!cached || cached.readProjection) return undefined;
  const expectedRv = item.raw?.metadata?.resourceVersion;
  const cachedRv = cached.raw?.metadata?.resourceVersion;
  if (expectedRv && cachedRv && expectedRv !== cachedRv) return undefined;
  return cached;
}

interface InflightManifest {
  controller: AbortController;
  promise: Promise<ResourceItem>;
  subscribers: number;
}
const inflightManifests = new Map<string, InflightManifest>();

function loadFullManifest(context: string, item: ResourceItem, rv: string): { promise: Promise<ResourceItem>; release: () => void } {
  const key = JSON.stringify([context, item.kind, item.namespace ?? null, item.name, item.uid, rv]);
  let entry = inflightManifests.get(key);
  if (!entry) {
    const controller = new AbortController();
    const read = k8s.getResource
      ? k8s.getResource(context, item.kind, item.name, item.namespace, { priority: 'high' }, controller.signal).then((full) => [full])
      : k8s.getResources(context, item.kind, 'all', controller.signal);
    const promise = read.then((items) => {
      const full = items.find((candidate) => candidate.uid === item.uid);
      if (!full) throw new Error('The resource no longer exists in the cluster.');
      useDetailCache.getState().upsert(context, full);
      return full;
    }).finally(() => {
      if (inflightManifests.get(key) === entry) inflightManifests.delete(key);
    });
    entry = { controller, promise, subscribers: 0 };
    inflightManifests.set(key, entry);
  }
  const current = entry;
  current.subscribers++;
  let released = false;
  return {
    promise: current.promise,
    release: () => {
      if (released) return;
      released = true;
      current.subscribers--;
      // Defer abort by a microtask so React StrictMode remounts reuse the in-flight GET.
      queueMicrotask(() => {
        if (current.subscribers <= 0) {
          if (inflightManifests.get(key) === current) inflightManifests.delete(key);
          current.controller.abort();
        }
      });
    },
  };
}

/** Renders its children with a complete object, loading it from the cluster first when the cached copy is trimmed. */
export function FullManifest({
  item,
  loadingLabel = 'Loading full manifest…',
  children,
}: {
  item: ResourceItem;
  loadingLabel?: string;
  children: (item: ResourceItem) => ReactNode;
}) {
  const context = useClusterStore((state) => state.currentContext);
  const required = needsFullManifest(item);
  const rv = item.raw?.metadata?.resourceVersion ?? '';
  const [loaded, setLoaded] = useState<{ uid: string; rv: string; item: ResourceItem } | undefined>(() => {
    if (!required) return undefined;
    const hit = cachedFullManifest(context, item);
    return hit ? { uid: item.uid, rv, item: hit } : undefined;
  });
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!required || !context) return;
    const hit = cachedFullManifest(context, item);
    if (hit) {
      setError(undefined);
      setLoaded({ uid: item.uid, rv, item: hit });
      return;
    }
    let active = true;
    setError(undefined);
    const { promise, release } = loadFullManifest(context, item, rv);
    promise.then((full) => {
      if (active) setLoaded({ uid: item.uid, rv, item: full });
    }).catch((reason) => {
      if (active) setError(String(reason?.message ?? reason));
    });
    return () => {
      active = false;
      release();
    };
  }, [required, context, item.kind, item.name, item.namespace, item.uid, rv]);

  if (!required) return <>{children(item)}</>;
  if (loaded?.uid === item.uid) return <>{children(loaded.item)}</>;
  if (error) return <p role="alert" className="p-4 text-xs text-[var(--status-error)]">Cannot load {item.name}: the full resource could not be loaded. {error}</p>;
  return <div className="p-4 text-[var(--text-muted)] flex items-center gap-2 text-xs"><Loader2 size={14} className="animate-spin" /> {loadingLabel}</div>;
}
