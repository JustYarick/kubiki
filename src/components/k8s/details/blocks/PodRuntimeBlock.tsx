import { useState } from 'react';
import { Box } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { podContainers } from '../../../../core/resources/containers';
import { quantity } from '../../../../core/resources/quantities';
import { useClusterStore } from '../../../../state/cluster_store';
import { usePodMetrics } from '../../../../providers/use_pod_metrics';
import { DetailsSection } from '../DetailsSection';
import { PodPerformanceBlock } from './PodPerformanceBlock';
import { ContainerCard } from './ContainerCard';

/** Pod totals and individual rows share one metrics snapshot and pause control. */
export function PodRuntimeBlock({ item, onLogs, onShell }: { item: ResourceItem; onLogs: (name: string) => void; onShell: (name: string) => void }) {
  const context = useClusterStore(state => state.currentContext);
  const [paused, setPaused] = useState(false);
  const metrics = usePodMetrics(context, item, paused);
  const spec = item.raw?.spec ?? item.spec ?? {};
  const status = item.raw?.status ?? item.statusRaw ?? {};
  const containers = podContainers(item);
  const ordered = (['application', 'sidecar', 'init', 'ephemeral'] as const).flatMap(role => containers.filter(container => (container.role ?? 'application') === role));
  // Native sidecars live in initContainers and have initContainerStatuses.
  const definitions = [...(spec.containers ?? []), ...(spec.initContainers ?? []), ...(spec.ephemeralContainers ?? [])];
  const statuses = [...(status.containerStatuses ?? []), ...(status.initContainerStatuses ?? []), ...(status.ephemeralContainerStatuses ?? [])];
  const current = metrics.usage.cpu !== null || metrics.usage.memory !== null ? metrics.sample : undefined;
  return <>
    <PodPerformanceBlock item={item} metrics={metrics} paused={paused} onPausedChange={setPaused} />
    <DetailsSection title={`Containers (${containers.length})`} label="Containers" icon={Box}>
      <div className="pod-containers-list">{ordered.map(container => {
        const sample = container.state === 'terminated' ? undefined : current?.containers.find(entry => entry.name === container.name);
        return <ContainerCard key={container.name} container={container}
          spec={definitions.find(definition => definition.name === container.name)}
          status={statuses.find(entry => entry.name === container.name)}
          usage={{ cpu: quantity(sample?.cpu), memory: quantity(sample?.memory), stale: !!sample && (metrics.stale || !!metrics.error) }}
          onLogs={onLogs} onShell={onShell} />;
      })}</div>
      {!containers.length && <p className="details-caption">No containers are defined for this Pod.</p>}
    </DetailsSection>
  </>;
}
