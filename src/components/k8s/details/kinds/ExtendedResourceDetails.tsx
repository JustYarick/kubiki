import { ResourceReferences } from '../blocks/ResourceReferences';
import { Fragment } from 'react';
import type { ResourceItem } from '../../../../types/k8s';
import { matchesResourceRef } from '../../../../core/resources/identity';
import { fieldText, fieldValue, presentationFor } from '../../../../core/resources/resource_presentations';
import { useResourceStore } from '../../../../state/resource_store';
import { DetailsSection } from '../DetailsSection';
import { StructuredFields } from '../blocks/StructuredFields';
import { ConditionsTable } from '../blocks/ConditionsTable';
import { MetadataBlock } from '../blocks/MetadataBlock';
import { UsedByList } from '../blocks/UsedByList';
import { ProblemsBanner } from '../blocks/ProblemsBanner';

function MetricValue({ value }: { value: any }) {
  return <>{value?.averageUtilization != null ? `${value.averageUtilization}%` : value?.averageValue ?? value?.value ?? '—'}</>;
}

function AutoscalingMetrics({ raw }: { raw: any }) {
  const metrics: any[] = raw.spec?.metrics ?? (raw.spec?.targetCPUUtilizationPercentage != null ? [{ type: 'Resource', resource: { name: 'cpu', target: { averageUtilization: raw.spec.targetCPUUtilizationPercentage } } }] : []);
  if (!metrics.length) return null;
  return <DetailsSection title="Metrics · current / target"><div className="details-table-scroll"><table className="details-table"><thead><tr><th>Metric</th><th>Current</th><th>Target</th></tr></thead><tbody>{metrics.map((metric, index) => {
    const type = String(metric.type ?? 'Resource'); const key = type.charAt(0).toLowerCase() + type.slice(1);
    const spec = metric[key] ?? {}; const name = spec.name ?? spec.metric?.name ?? type;
    const currentMetric = (raw.status?.currentMetrics ?? []).find((candidate: any) => candidate.type === type && (candidate[key]?.name ?? candidate[key]?.metric?.name ?? type) === name);
    const current = currentMetric?.[key]?.current ?? (name === 'cpu' ? { averageUtilization: raw.status?.currentCPUUtilizationPercentage } : undefined);
    return <tr key={index}><td>{name}{spec.container ? ` · ${spec.container}` : ''}<span className="block text-[var(--text-muted)]">{type}</span></td><td><MetricValue value={current} /></td><td><MetricValue value={spec.target} /></td></tr>;
  })}</tbody></table></div></DetailsSection>;
}

export function ExtendedResourceDetails({ item, onNavigate }: { item: ResourceItem; onNavigate: (item: ResourceItem) => void }) {
  const resources = useResourceStore(state => state.resources);
  const raw = item.raw ?? { spec: item.spec, status: item.statusRaw };
  const presentation = presentationFor(item);
  const targetRef = raw.spec?.scaleTargetRef ?? raw.spec?.targetRef;
  const target = targetRef ? [...(resources[targetRef.kind]?.values() ?? [])].find(entry => matchesResourceRef(entry, { ...targetRef, namespace: item.namespace })) : undefined;
  return <div className="details-stack">
    <ProblemsBanner item={item} />
    {!!presentation?.fields.length && <DetailsSection title={item.kind === 'HorizontalPodAutoscaler' ? 'Autoscaling' : `${item.kind} summary`}>
      <dl className="details-properties">{presentation?.fields.map(field => <Fragment key={field.label}><dt>{field.label}</dt><dd>{field.label === 'Target' && target ? <button className="details-link" onClick={() => onNavigate(target)}>{targetRef.kind}/{target.name}</button> : fieldText(fieldValue(raw, field.path)) ?? (field.path === 'spec.minReplicas' ? '1 (default)' : '—')}</dd></Fragment>)}</dl>
      {item.kind === 'HorizontalPodAutoscaler' && <p className="text-xs text-[var(--text-muted)] mt-2">Current: {raw.status?.currentReplicas ?? '—'} → Desired: {raw.status?.desiredReplicas ?? '—'} replicas</p>}
    </DetailsSection>}
    {item.kind === 'HorizontalPodAutoscaler' && <>
      <AutoscalingMetrics raw={raw} />
      <StructuredFields title="Target metrics" value={raw.spec?.metrics ?? (raw.spec?.targetCPUUtilizationPercentage != null ? { targetCPUUtilizationPercentage: raw.spec.targetCPUUtilizationPercentage } : undefined)} />
      <StructuredFields title="Current metrics" value={raw.status?.currentMetrics ?? (raw.status?.currentCPUUtilizationPercentage != null ? { currentCPUUtilizationPercentage: raw.status.currentCPUUtilizationPercentage } : undefined)} />
    </>}
    {presentation?.sections?.map(section => <StructuredFields key={section.label} title={section.label} value={fieldValue(raw, section.path)} />)}
    <ResourceReferences key={item.uid} item={item} onNavigate={onNavigate} />
    <ConditionsTable conditions={raw.status?.conditions} />
    <UsedByList item={item} onNavigate={onNavigate} />
    <MetadataBlock item={item} onNavigate={onNavigate} />
  </div>;
}
