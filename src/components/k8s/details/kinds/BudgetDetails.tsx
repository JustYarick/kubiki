import { ShieldCheck } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { useResourceStore } from '../../../../state/resource_store';
import { podsForSelector, workloadsForPods } from '../../../../core/resources/detail_links';
import { summaryTitle } from '../../../../core/resources/kind_labels';
import { DetailsSection } from '../DetailsSection';
import { KindSummary } from '../blocks/KindSummary';
import { DetailTable } from '../blocks/DetailTable';
import { ReferenceRows } from '../blocks/ReferenceRows';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { UsedByList } from '../blocks/UsedByList';
import { ConditionsTable } from '../blocks/ConditionsTable';
import { MetadataBlock } from '../blocks/MetadataBlock';

interface BudgetDetailsProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
}

/** Pod disruption budgets: budget window, protected pods and the workloads behind them. */
export function BudgetDetails({ item, onNavigate }: BudgetDetailsProps) {
  const resources = useResourceStore(state => state.resources);
  const raw = item.raw ?? {};
  const spec = raw.spec ?? {};
  const status = raw.status ?? item.statusRaw ?? {};
  const selector = spec.selector ?? spec.podSelector;
  const pods = podsForSelector(resources, selector, item.namespace);
  const workloads = workloadsForPods(resources, pods);

  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />

      <KindSummary
        title={summaryTitle(item.kind)}
        icon={ShieldCheck}
        tiles={[
          { label: 'Healthy pods', value: status.currentHealthy ?? '—', tone: 'ok' },
          { label: 'Desired pods', value: status.desiredHealthy ?? '—' },
          { label: 'Disruptions allowed', value: status.disruptionsAllowed ?? '—', tone: 'info' },
          { label: 'Expected pods', value: status.expectedPods ?? '—', tone: 'muted' },
        ]}
        rows={[
          { label: 'Min available', value: spec.minAvailable ?? '—' },
          { label: 'Max unavailable', value: spec.maxUnavailable ?? '—' },
          {
            label: 'Pod selector',
            value: selector
              ? Object.entries(selector.matchLabels ?? {}).map(([key, value]) => `${key}=${value}`).join(', ') || 'All pods in namespace'
              : 'All pods in namespace',
          },
        ]}
      />

      <DetailsSection title={`Selected pods (${pods.length})`} label="Pods protected by this budget">
        <DetailTable
          columns={['Pod', 'Status', 'Node']}
          rows={pods.map(pod => [
            <button key={pod.uid} type="button" className="details-link" onClick={() => onNavigate(pod)}>{pod.name}</button>,
            pod.status ?? '—',
            pod.node ?? pod.raw?.spec?.nodeName ?? '—',
          ])}
          empty="No pod in this namespace matches the selector of this budget."
        />
      </DetailsSection>

      {!!workloads.length && (
        <DetailsSection title="Protected workloads">
          <ReferenceRows
            entries={workloads.map(workload => ({
              kind: workload.kind,
              name: workload.name,
              namespace: workload.namespace,
              item: workload,
            }))}
            onNavigate={onNavigate}
          />
        </DetailsSection>
      )}

      <UsedByList item={item} onNavigate={onNavigate} />
      <ConditionsTable conditions={status.conditions} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
