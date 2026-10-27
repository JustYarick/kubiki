import { useCallback, useEffect, useMemo, useState } from 'react';
import { useResourceStore } from '../state/resource_store';
import { customResourceType, type CustomResourceType } from '../core/resources/custom_resource_types';
import type { ResourceItem } from '../types/k8s';
import { ReadSubscriptions, type ReadSnapshot } from './read_subscriptions';
import { k8s } from './k8s_provider';
const subscriptions = new ReadSubscriptions<ResourceItem[]>(async (key, signal) => {
  const { context, namespace, type } = JSON.parse(key) as { context: string; namespace: string | null; type: CustomResourceType };
  // Storage and target namespaces can differ; owners may live outside the release's namespace.
  const items = await k8s.getCustomResources(context, type.name, type.uid, namespace ?? null, signal);
  return namespace ? items.filter(item => item.raw?.spec?.storageNamespace === namespace || item.raw?.spec?.targetNamespace === namespace || item.namespace === namespace) : items;
}, 30000);
export function useFluxHelmOwners(context: string, namespace: string | null) {
  const crds = useResourceStore(state => state.resources.CustomResourceDefinition);
  const type = useMemo(() => [...crds.values()].map(customResourceType).find(type => type?.kind === 'HelmRelease' && type.group === 'helm.toolkit.fluxcd.io'), [crds]);
  const key = type ? JSON.stringify({ context, namespace, type }) : '';
  const [state, setState] = useState<ReadSnapshot<ResourceItem[]> & { key: string }>({ key: '', loading: false });
  useEffect(() => key ? subscriptions.subscribe(key, value => setState({ ...value, key })) : undefined, [key]);
  const refresh = useCallback(() => { if (key) subscriptions.refresh(key); }, [key]);
  return { loading: !!key && (state.key !== key || state.loading), items: key && state.key === key ? state.data ?? [] : [], error: key && state.key === key ? state.error : undefined, refresh };
}
