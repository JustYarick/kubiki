import type { MutationReview } from '../providers/mutation_review';
import { create } from 'zustand';
import type { ResourceRef } from '../core/resources/resource_types';

export interface MutationConfirmRequest {
  id: string;
  resource: ResourceRef;
  review: string;
  details?: MutationReview;
}

interface MutationConfirmState {
  pending: MutationConfirmRequest | null;
  setPending: (req: MutationConfirmRequest | null) => void;
  resolve: (approved: boolean) => Promise<void>;
}

export const useMutationConfirmStore = create<MutationConfirmState>((set, get) => ({
  pending: null,
  setPending: (pending) => set({ pending }),
  resolve: async (approved: boolean) => {
    const current = get().pending;
    set({ pending: null });
    if (!current) return;

    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('resolve_mutation_confirm', { id: current.id, approved });
      } catch (err) {
        console.error('Failed to resolve mutation confirmation', err);
      }
    }
  },
}));

let listener: Promise<() => void> | undefined;
let subscribers = 0;
export async function setupMutationConfirmListener(): Promise<() => void> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return () => {};
  subscribers++;
  listener ??= import('@tauri-apps/api/event').then(({ listen }) => listen<MutationConfirmRequest>('mutation-confirm-request', event => useMutationConfirmStore.getState().setPending(event.payload))).catch(error => {
    console.error('Failed to setup mutation confirm listener', error);
    return () => {};
  });
  const registration = listener;
  const unlisten = await registration;
  let closed = false;
  return () => {
    if (closed) return; closed = true;
    if (--subscribers === 0 && listener === registration) {
      try { void Promise.resolve(unlisten()).catch(() => {}); } catch {}
      listener = undefined;
    }
  };
}
