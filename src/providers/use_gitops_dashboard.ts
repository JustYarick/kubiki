import { useEffect, useMemo, useRef, useState } from 'react';
import { useClusterStore } from '../state/cluster_store';
import { useResourceStore } from '../state/resource_store';
import { customResourceType, resourceBucket, type CustomResourceType } from '../core/resources/custom_resource_types';
import { gitOpsFamily } from '../core/resources/gitops';
import type { ResourceItem } from '../types/k8s';
import { k8s } from './k8s_provider';
import { normalizeK8sError, type K8sRequestError } from './errors';

interface Snapshot { type: CustomResourceType; items?: ResourceItem[]; error?: K8sRequestError }
export function useGitOpsDashboard(family: 'flux' | 'argocd') {
  const context = useClusterStore(state => state.currentContext);
  const scope = useClusterStore(state => state.selectedNamespace);
  const crds = useResourceStore(state => state.resources.CustomResourceDefinition);
  const definitions = useMemo(() => [...crds.values()].map(customResourceType).filter((type): type is CustomResourceType => !!type && gitOpsFamily(type) === family).sort((a, b) => a.name.localeCompare(b.name)), [crds, family]);
  const key = JSON.stringify([context, scope, definitions.map(type => [type.name, type.uid, type.version])]);
  const types = useRef(definitions); types.current = definitions;
  const [epoch, setEpoch] = useState(0);
  const [state, setState] = useState<{ key: string; loading: boolean; entries: Snapshot[]; updated?: number }>({ key: '', loading: false, entries: [] });
  useEffect(() => {
    if (!context) return;
    const abort = new AbortController();
    const currentTypes = types.current;
    setState(previous => ({ key, loading: currentTypes.length > 0, entries: previous.key === key ? previous.entries : [] }));
    // Bound parallel reads even when a cluster installs many Flux CRDs.
    let next = 0;
    const results: Snapshot[] = [];
    const worker = async () => {
      while (!abort.signal.aborted && next < currentTypes.length) {
        const type = currentTypes[next++];
        try {
          const items = await k8s.getCustomResources(context, type.name, type.uid, type.namespaced && scope !== 'all' ? scope : null, abort.signal);
          if (items.some(item => resourceBucket(item) !== type.key)) throw new Error('Custom resource list does not match this CRD');
          if (abort.signal.aborted) return;
          // Share complete collections so the standard inspector can resolve references.
          useResourceStore.getState().setResourcesForKind(type.key, items);
          results.push({ type, items });
        } catch (error) {
          results.push({ type, error: normalizeK8sError(error) });
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, currentTypes.length) }, worker)).then(() => {
      if (abort.signal.aborted) return;
      setState(previous => ({ key, loading: false, updated: Date.now(), entries: results.map(result => ({ ...result, items: result.items ?? (previous.key === key ? previous.entries.find(entry => entry.type.key === result.type.key)?.items : undefined) })) }));
    });
    return () => abort.abort();
  }, [key, context, scope, epoch]);
  const current = state.key === key ? state : { loading: !!context && definitions.length > 0, entries: [], updated: undefined };
  return { ...current, definitions, context, scope, refresh: () => setEpoch(value => value + 1) };
}
