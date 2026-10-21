import type { ResourceItem } from '../../../../types/k8s';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { IngressRulesBlock } from '../blocks/IngressRulesBlock';
import { ConditionsTable } from '../blocks/ConditionsTable';
import { MetadataBlock } from '../blocks/MetadataBlock';

interface IngressDetailsProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
}

export function IngressDetails({ item, onNavigate }: IngressDetailsProps) {
  const raw = item.raw ?? {};
  const status = raw.status ?? item.statusRaw ?? {};

  return (
    <div className="details-stack">
      {/* 1. "What's wrong" diagnostic banner */}
      <ProblemsBanner item={item} />

      {/* 2. Ingress Rules & TLS */}
      <IngressRulesBlock item={item} onNavigate={onNavigate} />

      {/* 3. Conditions */}
      <ConditionsTable conditions={status.conditions} />

      {/* 4. Metadata */}
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
