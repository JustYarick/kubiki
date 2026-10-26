import { useCallback, useEffect, useMemo, useState } from 'react';
import { useClusterStore } from '../state/cluster_store';
import { useResourceStore } from '../state/resource_store';
import { customResourceType, resourceBucket, type CustomResourceType } from '../core/resources/custom_resource_types';
import { gitOpsFamily } from '../core/resources/gitops';
import type { ResourceItem } from '../types/k8s';
import { k8s } from './k8s_provider';
import { normalizeK8sError, type K8sRequestError } from './errors';
import { ReadSubscriptions, type ReadSnapshot } from './read_subscriptions';

export interface GitOpsSnapshot { type: CustomResourceType; items?: ResourceItem[]; error?: K8sRequestError }
interface Data { entries: GitOpsSnapshot[]; events?: ResourceItem[]; eventError?: K8sRequestError }
const subscriptions = new ReadSubscriptions<Data>(async (key, signal, previous) => {
  const { context, scope, definitions } = JSON.parse(key) as { context: string; scope: string; definitions: CustomResourceType[] };
  const entries: GitOpsSnapshot[] = [];
  let next = 0;
  const worker = async () => {
    while (!signal.aborted && next < definitions.length) {
      const type = definitions[next++];
      try {
        const items = await k8s.getCustomResources(context, type.name, type.uid, type.namespaced && scope !== 'all' ? scope : null, signal);
        if (items.some(item => resourceBucket(item) !== type.key)) throw new Error('Custom resource list does not match this CRD');
        entries.push({ type, items });
      } catch (error) {
        entries.push({ type, items: previous?.entries.find(entry => entry.type.key === type.key)?.items, error: normalizeK8sError(error) });
      }
    }
  };
  let events = previous?.events;
  let eventError: K8sRequestError | undefined;
  const activity = async () => {
    try { events = await k8s.getResources(context, 'Event', scope, signal); }
    catch (error) { eventError = normalizeK8sError(error); }
  };
  await Promise.all([activity(), ...Array.from({ length: Math.min(3, definitions.length) }, worker)]);
  return { entries: entries.sort((a, b) => a.type.name.localeCompare(b.type.name)), events, eventError };
});

export function useGitOpsDashboard(family: 'flux' | 'argocd') {
  const context = useClusterStore(state => state.currentContext);
  const scope = useClusterStore(state => state.selectedNamespace);
  const crds = useResourceStore(state => state.resources.CustomResourceDefinition);
  const definitions = useMemo(() => [...crds.values()].map(customResourceType).filter((type): type is CustomResourceType => !!type && gitOpsFamily(type) === family).sort((a, b) => a.name.localeCompare(b.name)), [crds, family]);
  const key = context && definitions.length ? JSON.stringify({ context, scope, definitions }) : '';
  const [state, setState] = useState<ReadSnapshot<Data> & { key: string }>({ key: '', loading: false });
  useEffect(() => {
    if (!key) return;
    let last: Data | undefined;
    return subscriptions.subscribe(key, snapshot => {
      if (snapshot.data && last !== snapshot.data) {
        last = snapshot.data;
        for (const entry of snapshot.data.entries) if (entry.items && !entry.error) useResourceStore.getState().setResourcesForKind(entry.type.key, entry.items);
      }
      setState({ ...snapshot, key });
    });
  }, [key]);
  const refresh = useCallback(() => { if (key) subscriptions.refresh(key); }, [key]);
  const current = state.key === key ? state : { loading: !!key, data: undefined, updated: undefined, error: undefined };
  return { entries: current.data?.entries ?? [], events: current.data?.events ?? [], eventError: current.data?.eventError, loading: current.loading, updated: current.updated, error: current.error, definitions, context, scope, refresh };
}
