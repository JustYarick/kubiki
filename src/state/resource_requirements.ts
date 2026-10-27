import { create } from 'zustand';
import type { ResourceKind } from '../types/k8s';

/** Additional data needed by a view's local controls (for example its Related tab). */
export const useResourceRequirements = create<{ entries: Map<symbol, { context: string; kinds: readonly ResourceKind[]; namespace: string }> }>(() => ({ entries: new Map() }));

export function retainResourceKinds(context: string, kinds: readonly ResourceKind[], namespace: string): () => void {
  const id = Symbol();
  useResourceRequirements.setState(state => ({ entries: new Map(state.entries).set(id, { context, kinds, namespace }) }));
  return () => useResourceRequirements.setState(state => {
    const entries = new Map(state.entries); entries.delete(id); return { entries };
  });
}
