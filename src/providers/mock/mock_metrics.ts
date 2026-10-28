import type { ResourceItem, ResourceKind } from '../../types/k8s';
import type { OverviewMetrics } from '../overview_metrics';

/** Aggregate node usage from the same pod samples, independent of namespace filters. */
export function buildMockMetrics(resources: Record<ResourceKind, ResourceItem[]>, context: string, namespace: string | null): OverviewMetrics {
  const timestamp = new Date(Date.now()).toISOString();
  const tick = Math.floor(Date.now() / 15000) % 17;
  const usage = new Map<string, { cpu: number; memory: number }>();
  const pods = resources.Pod.flatMap((pod, index) => {
    if (pod.status !== 'Running') return [];
    const containers = (pod.containers?.length ? pod.containers : [{ name: 'app' }]).map((container, i) => ({
      name: container.name, cpu: `${70 + (index * 47 + i * 19 + tick) % 350}m`, memory: `${40 + (index * 37 + i * 17) % 220}Mi`,
    }));
    const total = usage.get(pod.node!) ?? { cpu: 600, memory: 768 };
    for (const container of containers) {
      total.cpu += parseInt(container.cpu, 10);
      total.memory += parseInt(container.memory, 10);
    }
    usage.set(pod.node!, total);
    return !namespace || pod.namespace === namespace ? [{ name: pod.name, namespace: pod.namespace!, timestamp, window: '15s', containers }] : [];
  });
  const nodes = namespace ? null : resources.Node.map(node => {
    const total = usage.get(node.name) ?? { cpu: 600, memory: 768 };
    return { name: node.name, timestamp, window: '15s', cpu: `${total.cpu}m`, memory: `${total.memory}Mi` };
  });
  return { context, namespace, pods: { items: pods, error: null }, nodes: { items: nodes, error: null } };
}
