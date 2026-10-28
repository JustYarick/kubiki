import { useEffect, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { k8s } from '../providers/k8s_provider';
import { useClusterStore } from '../state/cluster_store';
import type { ResourceItem } from '../types/k8s';

/** The watch cache omits CRD schemas; they must be present before a manifest can be edited and saved. */
export const needsFullManifest = (item: ResourceItem) => item.kind === 'CustomResourceDefinition' && !k8s.demo;

/** Renders its children with a complete object, loading it from the cluster first when the cached copy is trimmed. */
export function FullManifest({ item, children }: { item: ResourceItem; children: (item: ResourceItem) => ReactNode }) {
  const context = useClusterStore((state) => state.currentContext);
  const required = needsFullManifest(item);
  const [loaded, setLoaded] = useState<{ uid: string; item: ResourceItem } | undefined>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!required || !context) return;
    const controller = new AbortController();
    setError(undefined);
    k8s.getResources(context, item.kind, 'all', controller.signal).then((items) => {
      if (controller.signal.aborted) return;
      const full = items.find((entry) => entry.uid === item.uid);
      if (full) setLoaded({ uid: item.uid, item: full });
      else setError('The resource no longer exists in the cluster.');
    }).catch((reason) => { if (!controller.signal.aborted) setError(String(reason?.message ?? reason)); });
    return () => controller.abort();
  }, [required, context, item.kind, item.uid]);

  if (!required) return <>{children(item)}</>;
  if (loaded?.uid === item.uid) return <>{children(loaded.item)}</>;
  if (error) return <p role="alert" className="p-4 text-xs text-[var(--status-error)]">Cannot edit {item.name}: the full manifest could not be loaded. {error}</p>;
  return <div className="p-4 text-[var(--text-muted)] flex gap-2 text-xs"><Loader2 size={14} className="animate-spin" /> Loading full manifest…</div>;
}
