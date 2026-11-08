import type { ResourceItem } from '../../../../types/k8s';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { NodePerformanceBlock } from '../blocks/NodePerformanceBlock';
import { useEffect } from 'react';
import { useClusterStore } from '../../../../state/cluster_store';
import { retainResourceKinds } from '../../../../state/resource_requirements';
import { DetailsSection } from '../DetailsSection';
import { StructuredFields } from '../blocks/StructuredFields';
import { useResourceStore } from '../../../../state/resource_store';
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
  const context = useClusterStore(state => state.currentContext);
  const podError = useResourceStore(state => state.loadErrors.Pod);
  useEffect(() => context ? retainResourceKinds(context, ['Pod'], 'all') : undefined, [context]);

  return (
    <div className="details-stack">
      {/* 1. "What's wrong" diagnostic banner */}
      <ProblemsBanner item={item} />

      {/* 2. CPU & Memory Gauge */}
      <NodePerformanceBlock key={`${context}/${item.uid}`} item={item} />

      {/* 3. Node Capacity & System Info */}
      <NodeCapacityBlock item={item} />
      <DetailsSection title="Node identity and scheduling">
        <dl className="details-properties">{[
          ['Provider ID', raw.spec?.providerID], ['Pod CIDRs', (raw.spec?.podCIDRs ?? [raw.spec?.podCIDR]).filter(Boolean).join(', ')],
          ['Scheduling', raw.spec?.unschedulable ? 'Cordoned' : 'Schedulable'],
          ['Region', raw.metadata?.labels?.['topology.kubernetes.io/region']], ['Zone', raw.metadata?.labels?.['topology.kubernetes.io/zone']],
          ['Machine ID', status.nodeInfo?.machineID], ['System UUID', status.nodeInfo?.systemUUID], ['Boot ID', status.nodeInfo?.bootID],
          ['Cached image groups', status.images?.length], ['Attached volumes', status.volumesAttached?.length], ['Volumes in use', status.volumesInUse?.length],
        ].map(([label, value]) => <div key={String(label)} className="contents"><dt>{label}</dt><dd>{value == null || value === '' ? '—' : String(value)}</dd></div>)}</dl>
      </DetailsSection>
      <StructuredFields title="Attached volumes" value={status.volumesAttached} />

      {/* 4. Allocated Resources & Pods on this node */}
      {podError && <p role="status" className="details-caption">Pod inventory is incomplete: {podError.message}</p>}
      <NodePodsBlock item={item} onNavigate={onNavigate} />

      {/* 5. Node Conditions (Ready, DiskPressure, MemoryPressure, etc.) */}
      <ConditionsTable conditions={status.conditions} />

      {/* 6. Metadata */}
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
