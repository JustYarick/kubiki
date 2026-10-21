import { create } from 'zustand';
import type { ResourceRef } from '../core/resources/resource_types';

export interface MutationConfirmRequest {
  id: string;
  resource: ResourceRef;
  review: string;
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

let unlistenFn: (() => void) | null = null;

export async function setupMutationConfirmListener(): Promise<() => void> {
  if (unlistenFn) return unlistenFn;
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return () => {};
  }

  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<MutationConfirmRequest>('mutation-confirm-request', (event) => {
      useMutationConfirmStore.getState().setPending(event.payload);
    });
    unlistenFn = () => {
      unlisten();
      unlistenFn = null;
    };
    return unlistenFn;
  } catch (err) {
    console.error('Failed to setup mutation confirm listener', err);
    return () => {};
  }
}
