import { useResourceStore } from '../../state/resource_store';
import { useClusterStore } from '../../state/cluster_store';
import { defaultContainer, podContainers } from '../../core/resources/containers';
import type { DockSession } from '../../state/dock_store';
import type { ResourceContainer } from '../../types/k8s';

export function useSessionContainers(session: DockSession, shell = false) {
  const pods = useResourceStore((s) => s.resources.Pod);
  const context = useClusterStore((s) => s.currentContext);
  const namedPod = !session.context || context === session.context ? [...pods.values()].find((p) => p.name === session.resourceName && p.namespace === session.namespace) : undefined;
  const recreated = Boolean(session.uid && namedPod && namedPod.uid !== session.uid);
  const pod = !session.context || context === session.context ? [...pods.values()].find((p) => session.uid ? p.uid === session.uid : p.name === session.resourceName && p.namespace === session.namespace) : undefined;
  const containers = pod ? podContainers(pod) : (session.allContainers ?? (session.container ? [session.container] : [])).map((name): ResourceContainer => ({ name, image: '', ready: false, restarts: 0, port: '-', state: 'unknown' }));
  const needsSelection = session.targetType === 'pod' && !session.container && containers.length > 1;
  const container = needsSelection ? '' : session.container ?? defaultContainer(pod, shell) ?? containers[0]?.name ?? '';
  return { pod, recreated, needsSelection, containers, container, context: session.context ?? context, uid: session.uid ?? pod?.uid };
}
