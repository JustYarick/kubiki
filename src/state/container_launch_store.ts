import { create } from 'zustand';
import type { ResourceItem } from '../types/k8s';
import { canExecContainer, podContainers } from '../core/resources/containers';
import { useClusterStore } from './cluster_store';
import { useResourceStore } from './resource_store';

interface ContainerLaunch {
  item: ResourceItem;
  context: string | null;
  shell: boolean;
  launch: (container: string) => void;
}
interface ContainerLaunchState {
  pending: ContainerLaunch | null;
  request: (item: ResourceItem | undefined, container: string | undefined, shell: boolean, launch: (container: string) => void) => boolean;
  choose: (container: string) => void;
  cancel: () => void;
}
/** A launch gate, never a session: dismissing this dialog cannot start a transport. */
export const useContainerLaunchStore = create<ContainerLaunchState>((set, get) => ({
  pending: null,
  request: (item, container, shell, launch) => {
    if (item?.kind !== 'Pod' || container || podContainers(item).length <= 1) return false;
    set({ pending: { item, context: useClusterStore.getState().currentContext, shell, launch } }); return true;
  },
  choose: container => {
    const pending = get().pending;
    if (!pending) return;
    const current = [...useResourceStore.getState().resources.Pod.values()].find(item => item.name === pending.item.name && item.namespace === pending.item.namespace);
    if (pending.context !== useClusterStore.getState().currentContext || (!current || current.uid !== pending.item.uid)) { set({ pending: null }); return; }
    const choice = podContainers(current).find(item => item.name === container);
    if (!choice || (pending.shell && !canExecContainer(choice))) return;
    set({ pending: null }); pending.launch(container);
  },
  cancel: () => set({ pending: null }),
}));
useClusterStore.subscribe((state, previous) => {
  if (state.currentContext !== previous.currentContext) useContainerLaunchStore.getState().cancel();
});
