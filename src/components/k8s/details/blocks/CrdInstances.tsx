import { customResourceType, resourceBucket } from '../../../../core/resources/custom_resource_types';
import { useWorkspaceStore } from '../../../../state/workspace_store';
import { useResourceStore } from '../../../../state/resource_store';
import { useUiStore } from '../../../../state/ui_store';
import { namespaceScopeLabel } from '../../../../core/resources/namespace_scope';
import { useEffect, useState } from 'react';
import { Link2, RefreshCw } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { useClusterStore } from '../../../../state/cluster_store';
import { k8s } from '../../../../providers/k8s_provider';
import type { CustomResourceInstance } from '../../../../providers/custom_resources';
import { normalizeK8sError, type K8sRequestError } from '../../../../providers/errors';
import { RequestErrorNotice } from '../../RequestErrorNotice';
import { ResourceKindBadge } from '../../ResourceKindBadge';
import { Button } from '../../../ui/Button';

export function CrdInstances({ item }: { item: ResourceItem }) {
  const definition = customResourceType(item);
  const context = useClusterStore(state => state.currentContext);
  const namespace = useClusterStore(state => state.selectedNamespace);
  const [epoch, refresh] = useState(0);
  const [limit, setLimit] = useState(100);
  const key = JSON.stringify([context, namespace, item.name, item.uid, epoch]);
  const [result, setResult] = useState<{ key: string; items: CustomResourceInstance[]; error?: K8sRequestError }>();
  useEffect(() => {
    const abort = new AbortController();
    setLimit(100);
    if (context) void k8s.getCustomResources(context, item.name, item.uid, item.raw?.spec?.scope === 'Cluster' || namespace === 'all' ? null : namespace, abort.signal)
      .then(items => { if (!abort.signal.aborted) setResult({ key, items }); },
        error => { if (!abort.signal.aborted) setResult({ key, items: [], error: normalizeK8sError(error, { operation: 'custom-resources', context }) }); });
    return () => abort.abort();
  }, [key, context, namespace, item.name, item.uid]);
  const current = result?.key === key ? result : undefined;
  return <section aria-label="Used by" className="details-section">
    <div className="details-section-heading bg-[var(--bg-secondary)] flex items-center justify-between gap-2 text-xs font-medium">
      <span className="flex items-center gap-1.5"><Link2 size={12} aria-hidden="true" />Used by{current && !current.error ? ` (${current.items.length} ${current.items.length === 1 ? 'instance' : 'instances'})` : ''}</span>
      <div className="flex items-center gap-1">{definition && <Button size="sm" onClick={() => useWorkspaceStore.getState().openResourceList(definition.key)}>Open {definition.kind} table</Button>}<Button size="sm" disabled={!context || !current} aria-label="Refresh CRD instances" onClick={() => refresh(value => value + 1)}><RefreshCw size={12} aria-hidden="true" />Refresh</Button></div>
    </div>
    <div className="p-2 space-y-2 text-xs">
      <p className="text-[var(--text-secondary)]">Instances of this custom resource type · {item.raw?.spec?.scope === 'Cluster' ? 'Cluster scoped' : namespaceScopeLabel(namespace)}</p>
      {!context ? <p>Select a cluster to load instances.</p> : !current ? <p role="status">Loading custom resources…</p>
        : current.error ? <RequestErrorNotice error={current.error} onRetry={() => refresh(value => value + 1)} />
          : <>{!current.items.length && <p>No instances found in this scope.</p>}{current.items.slice(0, limit).map(instance => <button type="button" key={instance.uid} className="details-resource-row" onClick={() => {
            const store = useResourceStore.getState();
            const key = resourceBucket(instance);
            store.setResourcesForKind(key, [...(store.resources[key]?.values() ?? []), instance]);
            store.selectItem(instance);
            useUiStore.setState({ rightTab: 'overview' });
          }}>
            <ResourceKindBadge kind={instance.kind} apiVersion={instance.apiVersion} /><span className="font-mono flex-1 min-w-0 break-all">{instance.name}</span><span className="text-[var(--text-secondary)]">{instance.namespace ?? 'cluster'}</span>
          </button>)}{current.items.length > limit && <Button size="sm" onClick={() => setLimit(value => value + 100)}>Show next 100</Button>}</>}
    </div>
  </section>;
}
