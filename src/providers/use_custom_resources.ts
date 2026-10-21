import { useEffect, useRef, useState } from 'react';
import { useClusterStore } from '../state/cluster_store';
import { useResourceStore } from '../state/resource_store';
import type { CustomResourceType } from '../core/resources/custom_resource_types';
import { resourceBucket } from '../core/resources/custom_resource_types';
import { k8s } from './k8s_provider';

export function useCustomResources(type?: CustomResourceType) {
  const context = useClusterStore(state => state.currentContext);
  const scope = useClusterStore(state => state.selectedNamespace);
  const [revision, refresh] = useState(0);
  const [loadingKey, setLoadingKey] = useState('');
  const [completedKey, setCompletedKey] = useState('');
  const key = type && context ? JSON.stringify([context, type.name, type.uid, type.namespaced ? scope : 'all']) : '';
  const typeRef = useRef(type); typeRef.current = type;
  useEffect(() => {
    const definition = typeRef.current;
    if (!key || !context || !definition) return;
    const abort = new AbortController();
    const store = useResourceStore.getState();
    store.setLoadError(definition.key, null);
    setLoadingKey(key);
    void k8s.getCustomResources(context, definition.name, definition.uid, definition.namespaced && scope !== 'all' ? scope : null, abort.signal).then(items => {
      if (abort.signal.aborted || useClusterStore.getState().currentContext !== context) return;
      if (items.some(item => resourceBucket(item) !== definition.key)) throw new Error('Custom resource list does not match this CRD');
      useResourceStore.getState().setResourcesForKind(definition.key, items);
    }).catch(error => {
      if (!abort.signal.aborted) useResourceStore.getState().setLoadError(definition.key, error);
    }).finally(() => { if (!abort.signal.aborted) { setCompletedKey(key); setLoadingKey(''); } });
    return () => abort.abort();
  }, [key, context, scope, revision]);
  return { loading: !!key && (completedKey !== key || loadingKey === key), refresh: () => refresh(value => value + 1) };
}
