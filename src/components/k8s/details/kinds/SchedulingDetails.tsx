import { CalendarClock, Flag, Layers, Timer } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { summaryTitle } from '../../../../core/resources/kind_labels';
import { KindSummary } from '../blocks/KindSummary';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { UsedByList } from '../blocks/UsedByList';
import { MetadataBlock } from '../blocks/MetadataBlock';

interface SchedulingDetailsProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
}

/** Priority classes: scheduling priority and preemption behaviour. */
export function PriorityClassDetails({ item, onNavigate }: SchedulingDetailsProps) {
  const raw = item.raw ?? {};
  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />
      <KindSummary
        title={summaryTitle(item.kind)}
        icon={Flag}
        tiles={[
          { label: 'Priority', value: raw.value ?? '—', tone: 'info' },
          { label: 'Global default', value: raw.globalDefault === true ? 'Yes' : 'No', tone: 'muted' },
          { label: 'Preemption', value: raw.preemptionPolicy ?? 'PreemptLowerPriority' },
        ]}
        rows={[{ label: 'Description', value: raw.description || '—' }]}
      />
      <UsedByList item={item} onNavigate={onNavigate} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}

/** Runtime classes: handler and the scheduling overhead it adds. */
export function RuntimeClassDetails({ item, onNavigate }: SchedulingDetailsProps) {
  const raw = item.raw ?? {};
  const spec = raw.spec ?? {};
  const overhead = spec.overhead ?? {};
  const scheduling = spec.scheduling ?? {};
  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />
      <KindSummary
        title={summaryTitle(item.kind)}
        icon={Timer}
        tiles={[
          { label: 'Handler', value: spec.handler ?? '—', tone: 'info' },
          { label: 'CPU overhead', value: overhead.podFixed ? `${overhead.podFixed} millicores` : '—', tone: 'muted' },
          { label: 'Memory overhead', value: overhead.podFixedMemory ? overhead.podFixedMemory : '—', tone: 'muted' },
        ]}
        rows={[
          { label: 'Node selector', value: scheduling.nodeSelector ? Object.entries(scheduling.nodeSelector).map(([key, value]) => `${key}=${value}`).join(', ') : '—' },
          { label: 'Tolerations', value: scheduling.tolerations?.length ? scheduling.tolerations.map((toleration: any) => toleration.key ?? 'all').join(', ') : '—' },
        ]}
      />
      <UsedByList item={item} onNavigate={onNavigate} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}

/** Coordination leases: who holds the lock and when it was renewed. */
export function LeaseDetails({ item, onNavigate }: SchedulingDetailsProps) {
  const raw = item.raw ?? {};
  const spec = raw.spec ?? {};
  const time = (value?: string) => (value ? new Date(value).toLocaleString() : '—');
  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />
      <KindSummary
        title={summaryTitle(item.kind)}
        icon={CalendarClock}
        tiles={[
          { label: 'Holder', value: spec.holderIdentity ?? '—', tone: 'info' },
          { label: 'Duration', value: spec.leaseDurationSeconds ? `${spec.leaseDurationSeconds}s` : '—', tone: 'muted' },
          { label: 'Transitions', value: spec.leaseTransitions ?? 0, tone: 'muted' },
        ]}
        rows={[
          { label: 'Acquired', value: time(spec.acquireTime) },
          { label: 'Renewed', value: time(spec.renewTime) },
        ]}
      />
      <UsedByList item={item} onNavigate={onNavigate} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}

/** Ingress classes: the controller that handles matching ingresses. */
export function IngressClassDetails({ item, onNavigate }: SchedulingDetailsProps) {
  const raw = item.raw ?? {};
  const spec = raw.spec ?? {};
  const parameters = spec.parameters ?? {};
  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />
      <KindSummary
        title={summaryTitle(item.kind)}
        icon={Layers}
        tiles={[
          { label: 'Controller', value: spec.controller ?? '—', tone: 'info' },
          { label: 'Parameters', value: parameters.kind ?? '—', tone: 'muted' },
        ]}
        rows={[
          { label: 'Parameter reference', value: parameters.name ? `${parameters.kind}/${parameters.name}` : '—' },
          { label: 'Parameter API group', value: parameters.apiGroup ?? '—' },
        ]}
      />
      <UsedByList item={item} onNavigate={onNavigate} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
