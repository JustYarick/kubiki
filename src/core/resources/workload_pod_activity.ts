import type { ResourceItem, ResourceKind } from '../../types/k8s';
import { ownerMatches, type OwnerReference } from './owner_references';

export interface WorkloadPodActivity {
  ready: number;
  total: number;
  pending: number;
  terminating: number;
}

export function hasWorkloadPodColumn(kind: ResourceKind): boolean {
  return ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'ReplicationController'].includes(kind);
}

function ownerIndex(items: Iterable<ResourceItem>) {
  const byUid = new Map<string, ResourceItem>();
  const byName = new Map<string, ResourceItem>();
  const key = (namespace: string | undefined, kind: string | undefined, name: string | undefined) => JSON.stringify([namespace, kind, name]);
  for (const item of items) {
    byUid.set(item.uid, item);
    byName.set(key(item.namespace, item.kind, item.name), item);
  }
  return (ref: OwnerReference, namespace: string | undefined) => {
    const item = (ref.uid ? byUid.get(ref.uid) : undefined) ?? byName.get(key(namespace, ref.kind, ref.name));
    return item?.namespace === namespace && ownerMatches(ref, item) ? item : undefined;
  };
}

/** Index owners once per snapshot instead of scanning every Pod for each row. */
export function workloadPodActivity(
  workloads: Iterable<ResourceItem>,
  pods: Iterable<ResourceItem>,
  replicaSets: Iterable<ResourceItem> = [],
): Map<string, WorkloadPodActivity> {
  const items = [...workloads];
  const workloadOwner = ownerIndex(items);
  const replicaSetOwner = ownerIndex(replicaSets);
  const result = new Map<string, WorkloadPodActivity>(items.map(item => [item.uid, { ready: 0, total: 0, pending: 0, terminating: 0 }]));
  for (const pod of pods) {
    const terminating = !!(pod.raw?.metadata ?? pod.metadata)?.deletionTimestamp || pod.status === 'Terminating';
    const status = pod.raw?.status ?? pod.statusRaw;
    const readyCondition = status?.conditions?.find((condition: any) => condition.type === 'Ready');
    const containers = status?.containerStatuses ?? pod.containers ?? [];
    const running = (status?.phase ?? pod.status) === 'Running';
    const ready = !terminating && running && (readyCondition ? readyCondition.status === 'True' : containers.length > 0 && containers.every((container: any) => container.ready === true));
    const matched = new Set<string>();
    for (const ref of (pod.raw?.metadata ?? pod.metadata)?.ownerReferences ?? []) {
      const direct = workloadOwner(ref, pod.namespace);
      if (direct) matched.add(direct.uid);
      if (ref.kind !== 'ReplicaSet') continue;
      const replicaSet = replicaSetOwner(ref, pod.namespace);
      for (const parent of (replicaSet?.raw?.metadata ?? replicaSet?.metadata)?.ownerReferences ?? []) {
        const deployment = parent.kind === 'Deployment' ? workloadOwner(parent, pod.namespace) : undefined;
        if (deployment) matched.add(deployment.uid);
      }
    }
    for (const uid of matched) {
      const activity = result.get(uid)!;
      activity.total++;
      if (ready) activity.ready++;
      if (terminating) activity.terminating++;
      else if (pod.raw?.status?.phase === 'Pending' || ['Pending', 'ContainerCreating', 'PodInitializing'].includes(pod.status ?? '')) activity.pending++;
      result.set(uid, activity);
    }
  }
  return result;
}
