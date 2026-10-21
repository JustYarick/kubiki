import type { ResourceItem } from '../../../../types/k8s';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { UsedByList } from '../blocks/UsedByList';
import { ConditionsTable } from '../blocks/ConditionsTable';
import { MetadataBlock } from '../blocks/MetadataBlock';
import { CrdInstances } from '../blocks/CrdInstances';
import { StructuredFields } from '../blocks/StructuredFields';

interface GenericResourceDetailsProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
}

export function GenericResourceDetails({ item, onNavigate }: GenericResourceDetailsProps) {
  const raw = item.raw ?? {};
  const spec = raw.spec ?? item.spec ?? {};

  return (
    <div className="details-stack">
      {/* 1. "What's wrong" diagnostic banner */}
      <ProblemsBanner item={item} />

      <StructuredFields title="Specification" value={spec} />
      <StructuredFields title="Status" value={Object.fromEntries(Object.entries(raw.status ?? item.statusRaw ?? {}).filter(([key]) => key !== 'conditions'))} />
      <StructuredFields title="Resource fields" value={Object.fromEntries(Object.entries(raw).filter(([key]) => !['apiVersion', 'kind', 'metadata', 'spec', 'status'].includes(key)))} />

      {/* 3. Used By (Consumers) */}
      {item.kind === 'CustomResourceDefinition'
        ? <CrdInstances item={item} />
        : item.kind !== 'Event' && <UsedByList item={item} onNavigate={onNavigate} />}

      {/* 4. Conditions */}
      <ConditionsTable conditions={(raw.status ?? item.statusRaw ?? {}).conditions} />

      {/* 5. Metadata */}
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
