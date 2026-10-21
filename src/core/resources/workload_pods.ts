import type { ResourceItem } from '../../types/k8s';

/**
 * Resolves child pods belonging to a workload (Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob).
 * Traverses ownerReferences UID chain and falls back to label selector matching.
 */
export function findWorkloadPods(
  workload: ResourceItem,
  resources: { Pod?: Map<string, ResourceItem>; ReplicaSet?: Map<string, ResourceItem>; Job?: Map<string, ResourceItem> }
): ResourceItem[] {
  if (workload.kind === 'Pod') return [workload];
  const pods = [...(resources.Pod?.values() ?? [])];
  const targetNs = workload.namespace;

  // Filter pods in the same namespace (unless cluster-scoped workload, which is unusual)
  const scopedPods = targetNs ? pods.filter((p) => p.namespace === targetNs) : pods;

  if (workload.kind === 'ReplicaSet' || workload.kind === 'StatefulSet' || workload.kind === 'DaemonSet') {
    return scopedPods.filter((pod) => {
      const owners = pod.raw?.metadata?.ownerReferences ?? [];
      if (owners.some((o: any) => o.uid === workload.uid || o.name === workload.name)) return true;

      // Fallback: matchLabels
      const matchLabels = (workload.raw?.spec ?? workload.spec)?.selector?.matchLabels;
      if (matchLabels && Object.keys(matchLabels).length > 0) {
        const podLabels = pod.labels ?? pod.raw?.metadata?.labels ?? {};
        return Object.entries(matchLabels).every(([k, v]) => podLabels[k] === v);
      }
      return false;
    });
  }

  if (workload.kind === 'Deployment') {
    const replicaSets = [...(resources.ReplicaSet?.values() ?? [])].filter(
      (rs) => !targetNs || rs.namespace === targetNs
    );
    // Find ReplicaSets owned by this Deployment
    const ownedRsUids = new Set<string>();
    const ownedRsNames = new Set<string>();
    for (const rs of replicaSets) {
      const owners = rs.raw?.metadata?.ownerReferences ?? [];
      if (owners.some((o: any) => o.uid === workload.uid || o.name === workload.name)) {
        if (rs.uid) ownedRsUids.add(rs.uid);
        ownedRsNames.add(rs.name);
      }
    }

    const matched = scopedPods.filter((pod) => {
      const owners = pod.raw?.metadata?.ownerReferences ?? [];
      if (owners.some((o: any) => o.kind === 'ReplicaSet' && (ownedRsUids.has(o.uid) || ownedRsNames.has(o.name)))) {
        return true;
      }
      // Also check direct owner or selector fallback
      if (owners.some((o: any) => o.uid === workload.uid || o.name === workload.name)) return true;

      const matchLabels = (workload.raw?.spec ?? workload.spec)?.selector?.matchLabels;
      if (matchLabels && Object.keys(matchLabels).length > 0) {
        const podLabels = pod.labels ?? pod.raw?.metadata?.labels ?? {};
        return Object.entries(matchLabels).every(([k, v]) => podLabels[k] === v);
      }
      return false;
    });
    return matched;
  }

  if (workload.kind === 'Job') {
    return scopedPods.filter((pod) => {
      const owners = pod.raw?.metadata?.ownerReferences ?? [];
      return owners.some((o: any) => o.uid === workload.uid || o.name === workload.name);
    });
  }

  if (workload.kind === 'CronJob') {
    const jobs = [...(resources.Job?.values() ?? [])].filter(
      (j) => !targetNs || j.namespace === targetNs
    );
    const ownedJobUids = new Set<string>();
    const ownedJobNames = new Set<string>();
    for (const job of jobs) {
      const owners = job.raw?.metadata?.ownerReferences ?? [];
      if (owners.some((o: any) => o.uid === workload.uid || o.name === workload.name)) {
        if (job.uid) ownedJobUids.add(job.uid);
        ownedJobNames.add(job.name);
      }
    }
    return scopedPods.filter((pod) => {
      const owners = pod.raw?.metadata?.ownerReferences ?? [];
      return owners.some((o: any) => o.kind === 'Job' && (ownedJobUids.has(o.uid) || ownedJobNames.has(o.name)));
    });
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
