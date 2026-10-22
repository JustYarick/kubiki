import { type ReactNode } from 'react';
import { Gauge, TrendingUp } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { useResourceStore } from '../../../../state/resource_store';
import { resourceByRef } from '../../../../core/resources/detail_links';
import { summaryTitle } from '../../../../core/resources/kind_labels';
import { DetailsSection } from '../DetailsSection';
import { KindSummary } from '../blocks/KindSummary';
import { DetailTable } from '../blocks/DetailTable';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { UsedByList } from '../blocks/UsedByList';
import { ConditionsTable } from '../blocks/ConditionsTable';
import { MetadataBlock } from '../blocks/MetadataBlock';

interface ScalingDetailsProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
}

function metricValue(value: any): string {
  if (value == null) return '—';
  if (typeof value === 'object') {
    if (value.averageUtilization != null) return `${value.averageUtilization}%`;
    if (value.averageValue != null) return String(value.averageValue);
    if (value.value != null) return String(value.value);
    return '—';
  }
  return String(value);
}

function targetLabel(metric: any): string {
  const type = String(metric.type ?? 'Resource');
  const spec = metric[type.charAt(0).toLowerCase() + type.slice(1)] ?? {};
  const name = spec.name ?? spec.metric?.name ?? type;
  return spec.container ? `${name} · ${spec.container}` : name;
}

/** Horizontal and vertical autoscalers: targets, metrics and scaling behaviour. */
export function ScalingDetails({ item, onNavigate }: ScalingDetailsProps) {
  const resources = useResourceStore(state => state.resources);
  const raw = item.raw ?? { spec: item.spec, status: item.statusRaw };
  const spec = raw.spec ?? {};
  const status = raw.status ?? {};
  const isVertical = item.kind === 'VerticalPodAutoscaler';

  const targetRef = isVertical ? spec.targetRef : spec.scaleTargetRef;
  const target = resourceByRef(resources, {
    kind: targetRef?.kind,
    name: targetRef?.name,
    namespace: targetRef?.namespace ?? item.namespace,
  }, { kinds: ['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet', 'ReplicationController'] });

  if (isVertical) return <VerticalAutoscaler item={item} spec={spec} status={status} target={target} onNavigate={onNavigate} />;

  const metrics: any[] = spec.metrics ?? (spec.targetCPUUtilizationPercentage != null
    ? [{ type: 'Resource', resource: { name: 'cpu', target: { averageUtilization: spec.targetCPUUtilizationPercentage } } }]
    : []);
  const currentMetrics: any[] = status.currentMetrics ?? [];

  const behaviorRows = (behavior: any): ReactNode[][] => {
    const rows: ReactNode[][] = [];
    for (const [direction, key] of [['Scale up', 'scaleUp'], ['Scale down', 'scaleDown']] as const) {
      const policies = behavior?.[key];
      if (!policies) continue;
      for (const policy of policies) {
        rows.push([
          direction,
          policy.type ?? '—',
          policy.value ?? '—',
          policy.periodSeconds ?? '—',
          policy.stabilizationWindowSeconds ?? '—',
        ]);
      }
    }
    return rows;
  };

  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />

      <KindSummary
        title={summaryTitle(item.kind)}
        icon={TrendingUp}
        tiles={[
          { label: 'Min replicas', value: spec.minReplicas ?? 1 },
          { label: 'Max replicas', value: spec.maxReplicas ?? '—' },
          { label: 'Current replicas', value: status.currentReplicas ?? '—', tone: 'info' },
          { label: 'Desired replicas', value: status.desiredReplicas ?? '—', tone: 'muted' },
        ]}
        rows={[
          {
            label: 'Target',
            value: targetRef?.name
              ? target
                ? <button type="button" className="details-link" onClick={() => onNavigate(target)}>{targetRef.kind}/{target.name}</button>
                : <span>{targetRef.kind}/{targetRef.name}</span>
              : '—',
          },
          { label: 'Target API version', value: targetRef?.apiVersion ?? '—' },
        ]}
      />

      <DetailsSection title="Metrics · current / target" icon={Gauge}>
        <DetailTable
          columns={['Metric', 'Type', 'Target', 'Current']}
          rows={metrics.map((metric) => {
            const type = String(metric.type ?? 'Resource');
            const key = type.charAt(0).toLowerCase() + type.slice(1);
            const specPart = metric[key] ?? {};
            const name = specPart.name ?? specPart.metric?.name ?? type;
            const current = currentMetrics.find((candidate: any) =>
              candidate.type === type && (candidate[key]?.name ?? candidate[key]?.metric?.name ?? type) === name);
            const currentValue = current?.[key]?.current
              ?? (name === 'cpu' ? { averageUtilization: status.currentCPUUtilizationPercentage } : undefined);
            return [targetLabel(metric), type, metricValue(specPart.target), metricValue(currentValue)];
          })}
          empty="No metrics configured. The autoscaler falls back to the resource CPU target when it is set."
        />
      </DetailsSection>

      {!!spec.behavior && (
        <DetailsSection title="Scaling behavior">
          <DetailTable
            columns={['Direction', 'Policy', 'Value', 'Period (s)', 'Stabilization (s)']}
            rows={behaviorRows(spec.behavior)}
            empty="No scaling behaviour policies configured."
          />
        </DetailsSection>
      )}

      <UsedByList item={item} onNavigate={onNavigate} />
      <ConditionsTable conditions={status.conditions} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}

function VerticalAutoscaler({
  item,
  spec,
  status,
  target,
  onNavigate,
}: ScalingDetailsProps & { spec: any; status: any; target?: ResourceItem }) {
  const recommendations: any[] = status.recommendation?.containerRecommendations ?? [];
  const containerPolicies: any[] = spec.resourcePolicy?.containerPolicies ?? [];

  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />

      <KindSummary
        title={summaryTitle(item.kind)}
        icon={TrendingUp}
        tiles={[
          { label: 'Update mode', value: spec.updatePolicy?.updateMode ?? 'Auto' },
          { label: 'Containers', value: recommendations.length || '—' },
          { label: 'Controlled resources', value: spec.resourcePolicy?.controlledResources?.join(', ') || 'All' },
          { label: 'Min allowed', value: spec.resourcePolicy?.minAllowed?.cpu ?? '—' },
        ]}
        rows={[
          {
            label: 'Target',
            value: spec.targetRef?.name
              ? target
                ? <button type="button" className="details-link" onClick={() => onNavigate(target)}>{spec.targetRef.kind}/{target.name}</button>
                : <span>{spec.targetRef.kind}/{spec.targetRef.name}</span>
              : '—',
          },
          { label: 'Update policy', value: spec.updatePolicy?.updateMode ?? 'Auto' },
          { label: 'Last applied revision', value: status.lastAppliedRecommendation?.name ?? '—' },
        ]}
      />

      <DetailsSection title="Container recommendations" icon={Gauge}>
        <DetailTable
          columns={['Container', 'Target CPU', 'Target memory']}
          rows={recommendations.map(recommendation => [
            recommendation.containerName ?? '—',
            recommendation.target?.cpu ?? '—',
            recommendation.target?.memory ?? '—',
          ])}
          empty="No recommendations reported yet. The controller needs matching pods to calculate them."
        />
      </DetailsSection>

      {!!containerPolicies.length && (
        <DetailsSection title="Resource policy">
          <DetailTable
            columns={['Container', 'Mode', 'Min CPU', 'Max CPU', 'Min memory', 'Max memory']}
            rows={containerPolicies.map((policy: any) => [
              policy.containerName ?? '*',
              policy.mode ?? 'Auto',
              policy.minAllowed?.cpu ?? '—',
              policy.maxAllowed?.cpu ?? '—',
              policy.minAllowed?.memory ?? '—',
              policy.maxAllowed?.memory ?? '—',
            ])}
          />
        </DetailsSection>
      )}

      {!!status.conditions?.length && <ConditionsTable conditions={status.conditions} />}
      <UsedByList item={item} onNavigate={onNavigate} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
