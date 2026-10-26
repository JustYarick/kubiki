import { useCallback, useEffect, useState } from 'react';
import { k8s } from './k8s_provider';
import { loadHelmInventory } from './helm_inventory';
import { ReadSubscriptions, type ReadSnapshot } from './read_subscriptions';
import type { HelmRelease } from './helm_types';
import { subscribeHelmChanges } from './use_helm_graph';

const subscriptions = new ReadSubscriptions<HelmRelease[]>(async (key, signal) => {
  const [context, namespace] = JSON.parse(key) as [string, string | null];
  return loadHelmInventory((...args) => k8s.getHelmReleases(...args), context, namespace, signal);
}, 30000);
export function useHelmInventory(context: string, namespace: string | null) {
  const key = JSON.stringify([context, namespace]);
  const [state, setState] = useState<ReadSnapshot<HelmRelease[]> & { key: string }>({ key, loading: true });
  useEffect(() => subscriptions.subscribe(key, snapshot => setState({ ...snapshot, key })), [key]);
  const refresh = useCallback(() => subscriptions.refresh(key), [key]);
  useEffect(() => subscribeHelmChanges(refresh), [refresh]);
  return { ...(state.key === key ? state : { loading: true, data: undefined, updated: undefined, error: undefined }), refresh };
}
