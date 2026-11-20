import type { ResourceItem } from '../../types/k8s';
import { ownerMatches, type OwnerReference } from './owner_references';

const DIRECT_WORKLOAD_KINDS = new Set(['ReplicaSet', 'StatefulSet', 'DaemonSet', 'ReplicationController']);
const ALL_WORKLOAD_KINDS = new Set(['ReplicaSet', 'StatefulSet', 'DaemonSet', 'ReplicationController', 'Deployment', 'Job', 'CronJob']);

function ownersOf(item: ResourceItem): OwnerReference[] {
  return (item.raw?.metadata?.ownerReferences ?? []) as OwnerReference[];
}

function matchesSelector(workload: ResourceItem, pod: ResourceItem): boolean {
  const matchLabels = (workload.raw?.spec ?? workload.spec)?.selector?.matchLabels;
  if (!matchLabels || Object.keys(matchLabels).length === 0) return false;
  const podLabels = pod.labels ?? pod.raw?.metadata?.labels ?? {};
  return Object.entries(matchLabels).every(([key, value]) => podLabels[key] === value);
}

/**
 * O(1) owner lookup matching `ownerMatches` semantics without scanning the full
 * ReplicaSet/Job list for every Pod (avoids O(Pods × ReplicaSets) on large clusters).
 */
function buildOwnerMatcher(items: ResourceItem[], expectedKind: string) {
  const byUid = new Map<string, ResourceItem>();
  const byName = new Map<string, ResourceItem[]>();
  const noUidByName = new Map<string, ResourceItem[]>();

  for (const item of items) {
    if (item.uid) {
      byUid.set(item.uid, item);
    } else if (item.name) {
      const list = noUidByName.get(item.name);
      if (list) list.push(item);
      else noUidByName.set(item.name, [item]);
    }
    if (item.name) {
      const list = byName.get(item.name);
      if (list) list.push(item);
      else byName.set(item.name, [item]);
    }
  }

  return (owner: OwnerReference): boolean => {
    if (owner.kind !== expectedKind || typeof owner.name !== 'string' || !owner.name) return false;
    if (owner.uid) {
      const direct = byUid.get(owner.uid);
      if (direct && ownerMatches(owner, direct, expectedKind)) return true;
      const incomplete = noUidByName.get(owner.name);
      return incomplete ? incomplete.some((item) => ownerMatches(owner, item, expectedKind)) : false;
    }
    const candidates = byName.get(owner.name);
    return candidates ? candidates.some((item) => ownerMatches(owner, item, expectedKind)) : false;
  };
}

/**
 * Selector fallback is only safe when the pod has no owner, or when its
 * ReplicaSet owner was not loaded into the current snapshot. A loaded owner
 * that points somewhere else means the pod belongs to another workload.
 */
function hasUnresolvedReplicaSetOwner(
  pod: ResourceItem,
  owners: OwnerReference[],
  replicaSetNames: ReadonlySet<string>,
): boolean {
  return owners.length > 0
    && owners.every((owner) => owner.kind === 'ReplicaSet')
    && owners.every((owner) =>
      !replicaSetNames.has(`${pod.namespace ?? ''}\0${owner.name ?? ''}`)
    );
}

/**
 * Resolves child pods belonging to a workload (Deployment, StatefulSet, DaemonSet,
 * ReplicaSet, ReplicationController, Job, CronJob). Traverses ownerReferences by
 * UID and only falls back to labels when no conflicting owner is loaded.
 */
export function findWorkloadPods(
  workload: ResourceItem,
  resources: { Pod?: Map<string, ResourceItem>; ReplicaSet?: Map<string, ResourceItem>; Job?: Map<string, ResourceItem> }
): ResourceItem[] {
  if (workload.kind === 'Pod') return [workload];
  if (!ALL_WORKLOAD_KINDS.has(workload.kind)) return [];
  const targetNs = workload.namespace;
  const scopedPods: ResourceItem[] = [];
  for (const pod of resources.Pod?.values() ?? []) {
    if (!targetNs || pod.namespace === targetNs) scopedPods.push(pod);
  }

  if (DIRECT_WORKLOAD_KINDS.has(workload.kind)) {
    return scopedPods.filter((pod) => {
      const owners = ownersOf(pod);
      if (owners.some((owner) => ownerMatches(owner, workload, workload.kind))) return true;
      return owners.length === 0 && matchesSelector(workload, pod);
    });
  }

  if (workload.kind === 'Deployment') {
    const replicaSetNames = new Set<string>();
    const ownedReplicaSets: ResourceItem[] = [];
    for (const rs of resources.ReplicaSet?.values() ?? []) {
      if (targetNs && rs.namespace !== targetNs) continue;
      replicaSetNames.add(`${rs.namespace ?? ''}\0${rs.name}`);
      if (ownersOf(rs).some((owner) => ownerMatches(owner, workload, 'Deployment'))) {
        ownedReplicaSets.push(rs);
      }
    }
    const matchesOwnedReplicaSet = buildOwnerMatcher(ownedReplicaSets, 'ReplicaSet');

    return scopedPods.filter((pod) => {
      const owners = ownersOf(pod);
      if (owners.some((owner) => matchesOwnedReplicaSet(owner))) {
        return true;
      }
      if (owners.some((owner) => ownerMatches(owner, workload, 'Deployment'))) return true;
      if (owners.length === 0 || hasUnresolvedReplicaSetOwner(pod, owners, replicaSetNames)) {
        return matchesSelector(workload, pod);
      }
      return false;
    });
  }

  if (workload.kind === 'Job') {
    return scopedPods.filter((pod) =>
      ownersOf(pod).some((owner) => ownerMatches(owner, workload, 'Job'))
    );
  }

  if (workload.kind === 'CronJob') {
    const ownedJobs: ResourceItem[] = [];
    for (const job of resources.Job?.values() ?? []) {
      if (targetNs && job.namespace !== targetNs) continue;
      if (ownersOf(job).some((owner) => ownerMatches(owner, workload, 'CronJob'))) {
        ownedJobs.push(job);
      }
    }
    const matchesOwnedJob = buildOwnerMatcher(ownedJobs, 'Job');
    return scopedPods.filter((pod) =>
      ownersOf(pod).some((owner) => matchesOwnedJob(owner))
    );
  }

  return [];
}

/**
 * Returns the preferred pod among workload pods:
 * 1. Running and Ready pod
 * 2. Any Running pod
 * 3. Most recently created pod
 * 4. First pod in list
 */
export function preferredWorkloadPod(pods: ResourceItem[]): ResourceItem | undefined {
  if (pods.length === 0) return undefined;
  if (pods.length === 1) return pods[0];

  const running = pods.filter((p) => p.status === 'Running');
  if (running.length > 0) {
    // Prefer ready
    const ready = running.find((p) => {
      const cs = (p.raw?.status?.containerStatuses ?? []) as any[];
      return cs.length > 0 && cs.every((c) => c.ready);
    });
    if (ready) return ready;
    return running[0];
  }

  // Sort by creationTimestamp descending
  const sorted = [...pods].sort((a, b) => {
    const timeA = new Date(a.raw?.metadata?.creationTimestamp ?? 0).getTime();
    const timeB = new Date(b.raw?.metadata?.creationTimestamp ?? 0).getTime();
    return timeB - timeA;
  });

  return sorted[0];
}
