import type { ResourceItem } from '../../../../types/k8s';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { MetricsGaugeBar } from '../blocks/MetricsGaugeBar';
import { NodeCapacityBlock } from '../blocks/NodeCapacityBlock';
import { NodePodsBlock } from '../blocks/NodePodsBlock';
import { ConditionsTable } from '../blocks/ConditionsTable';
import { MetadataBlock } from '../blocks/MetadataBlock';

interface NodeDetailsProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
}

export function NodeDetails({ item, onNavigate }: NodeDetailsProps) {
  const raw = item.raw ?? {};
  const status = raw.status ?? item.statusRaw ?? {};

  return (
    <div className="details-stack">
      {/* 1. "What's wrong" diagnostic banner */}
      <ProblemsBanner item={item} />

      {/* 2. CPU & Memory Gauge */}
      <MetricsGaugeBar item={item} />

      {/* 3. Node Capacity & System Info */}
      <NodeCapacityBlock item={item} />

      {/* 4. Allocated Resources & Pods on this node */}
      <NodePodsBlock item={item} onNavigate={onNavigate} />

      {/* 5. Node Conditions (Ready, DiskPressure, MemoryPressure, etc.) */}
      <ConditionsTable conditions={status.conditions} />

      {/* 6. Metadata */}
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
