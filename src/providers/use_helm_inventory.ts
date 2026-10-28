import { useCallback, useEffect, useState } from 'react';
import type { ReadSnapshot } from './read_subscriptions';
import type { HelmRelease } from './helm_types';
import { helmInventoryKey, refreshHelmInventory, subscribeHelmInventory } from './helm_inventory_subscriptions';

export function useHelmInventory(context: string, namespace: string | null, enabled = true) {
  const key = enabled ? helmInventoryKey(context, namespace) : '';
  const [state, setState] = useState<ReadSnapshot<HelmRelease[]> & { key: string }>({ key, loading: enabled });
  useEffect(() => key ? subscribeHelmInventory(context, namespace, snapshot => setState({ ...snapshot, key })) : undefined, [key, context, namespace]);
  const refresh = useCallback(() => { if (key) refreshHelmInventory(context, namespace); }, [key, context, namespace]);
  return { ...(state.key === key ? state : { loading: !!key, data: undefined, updated: undefined, error: undefined }), refresh };
}
