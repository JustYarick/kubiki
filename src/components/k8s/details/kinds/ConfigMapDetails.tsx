import type { ResourceItem } from '../../../../types/k8s';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { ConfigMapDataBlock } from '../blocks/ConfigMapDataBlock';
import { UsedByList } from '../blocks/UsedByList';
import { MetadataBlock } from '../blocks/MetadataBlock';

interface ConfigMapDetailsProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
}

export function ConfigMapDetails({ item, onNavigate }: ConfigMapDetailsProps) {
  return (
    <div className="details-stack">
      {/* 1. "What's wrong" diagnostic banner */}
      <ProblemsBanner item={item} />

      {/* 2. ConfigMap Data Block */}
      <ConfigMapDataBlock item={item} />

      {/* 3. Used by consumers */}
      <UsedByList item={item} onNavigate={onNavigate} />

      {/* 4. Metadata */}
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
