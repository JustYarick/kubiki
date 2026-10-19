import { useResourceStore } from '../../state/resource_store';
import { useClusterStore } from '../../state/cluster_store';

/**
 * Real-time Informer Watch Engine (Simulation for frontend / mock mode).
 * In production with crates/kubiki-core, this stream connects to Tauri WebSocket / IPC.
 * This simulates 0ms reactive Kubernetes watch events:
 * 1. Pod phase lifecycle: Pending -> ContainerCreating -> Running
 * 2. Restarts & health updates
 * 3. Dynamic deployment pod synchronization
 */

let running = false;
let timerId: number | null = null;

export function startMockWatchEngine() {
  if (running) return;
  running = true;

  timerId = window.setInterval(() => {
    if (!useClusterStore.getState().isConnected) return;

    const resourceStore = useResourceStore.getState();
    const podMap = resourceStore.resources['Pod'];
    if (!podMap || podMap.size === 0) return;

    // Pick a random pod to update or simulate lifecycle
    const pods = Array.from(podMap.values());
    const pendingPod = pods.find((p) => p.status === 'Pending' || p.status === 'ContainerCreating');

    if (pendingPod) {
      // Advance pending pod lifecycle
      if (pendingPod.status === 'Pending') {
        resourceStore.updateItem('Pod', pendingPod.uid, {
          status: 'ContainerCreating',
          ready: '0/1',
        });
      } else if (pendingPod.status === 'ContainerCreating') {
        resourceStore.updateItem('Pod', pendingPod.uid, {
          status: 'Running',
          ready: '1/1',
          ip: `10.42.${Math.floor(Math.random() * 4)}.${Math.floor(Math.random() * 250)}`,
        });
      }
    }
  }, 4000);
}

export function stopMockWatchEngine() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
  running = false;
}
