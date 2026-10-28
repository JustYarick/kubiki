import { create } from 'zustand';
import type { ResourceKind } from '../types/k8s';
import { RESOURCE_TYPES } from '../core/resources/resource_types';
import { namespaceNames } from '../core/resources/namespace_scope';

/** Additional data needed by a view's local controls (for example its Related tab). */
export const useResourceRequirements = create<{ entries: Map<symbol, { context: string; kinds: readonly ResourceKind[]; namespace: string }> }>(() => ({ entries: new Map() }));

export function retainResourceKinds(context: string, kinds: readonly ResourceKind[], namespace: string): () => void {
  // An empty namespace selection means no namespaced subscriptions; it must
  // never reach a transport as the literal Kubernetes namespace `[]`.
  const wanted = namespaceNames(namespace)?.length === 0 ? kinds.filter(kind => RESOURCE_TYPES.some(type => type.kind === kind && !type.namespaced)) : kinds;
  const id = Symbol();
  useResourceRequirements.setState(state => ({ entries: new Map(state.entries).set(id, { context, kinds: wanted, namespace }) }));
  return () => useResourceRequirements.setState(state => {
    const entries = new Map(state.entries); entries.delete(id); return { entries };
  });
}
