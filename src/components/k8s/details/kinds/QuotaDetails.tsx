import { Ruler, Scale } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { summaryTitle } from '../../../../core/resources/kind_labels';
import { quantity } from '../../../../core/resources/quantities';
import { DetailsSection } from '../DetailsSection';
import { KindSummary } from '../blocks/KindSummary';
import { DetailTable } from '../blocks/DetailTable';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { UsedByList } from '../blocks/UsedByList';
import { ConditionsTable } from '../blocks/ConditionsTable';
import { MetadataBlock } from '../blocks/MetadataBlock';

interface QuotaDetailsProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
}

function usageRatio(used: unknown, hard: unknown): number | undefined {
  const usedValue = typeof used === 'string' ? Number(quantity(used)) : typeof used === 'number' ? used : undefined;
  const hardValue = typeof hard === 'string' ? Number(quantity(hard)) : typeof hard === 'number' ? hard : undefined;
  if (!usedValue || !hardValue || hardValue <= 0) return undefined;
  return Math.min(100, Math.round((usedValue / hardValue) * 100));
}

/** Resource quotas: hard limits against actual usage. */
export function QuotaDetails({ item, onNavigate }: QuotaDetailsProps) {
  const raw = item.raw ?? {};
  const spec = raw.spec ?? {};
  const status = raw.status ?? item.statusRaw ?? {};
  const hard = status.hard ?? spec.hard ?? {};
  const used = status.used ?? {};
  const resources = Object.keys(hard);

  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />

      <KindSummary
        title={summaryTitle(item.kind)}
        icon={Scale}
        tiles={resources.slice(0, 4).map(resource => {
          const ratio = usageRatio(used[resource], hard[resource]);
          return {
            label: resource,
            value: `${used[resource] ?? '—'} / ${hard[resource] ?? '—'}`,
            tone: ratio === undefined ? 'muted' : ratio >= 100 ? 'danger' : ratio >= 80 ? 'warn' : 'ok',
            title: ratio === undefined ? undefined : `${ratio}% of the quota is used`,
          };
        })}
        rows={[
          { label: 'Scopes', value: spec.scopes?.length ? spec.scopes.join(', ') : 'All resources' },
          { label: 'Scope selector', value: spec.scopeSelector ? JSON.stringify(spec.scopeSelector) : '—' },
          { label: 'Tracked resources', value: resources.length || '—' },
        ]}
      />

      <DetailsSection title="Resource limits" icon={Scale}>
        <DetailTable
          columns={['Resource', 'Hard', 'Used', 'Usage']}
          rows={resources.map(resource => {
            const ratio = usageRatio(used[resource], hard[resource]);
            return [
              resource,
              String(hard[resource] ?? '—'),
              String(used[resource] ?? '—'),
              ratio === undefined
                ? '—'
                : <span className="details-usage" data-tone={ratio >= 100 ? 'danger' : ratio >= 80 ? 'warn' : 'ok'}>
                  <span className="details-usage-bar" style={{ width: `${Math.max(2, ratio)}%` }} />
                  <span className="details-usage-label">{ratio}%</span>
                </span>,
            ];
          })}
          empty="This quota does not limit any resource."
        />
      </DetailsSection>

      <UsedByList item={item} onNavigate={onNavigate} />
      <ConditionsTable conditions={status.conditions} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}

/** Limit ranges: default, minimum and maximum values per container. */
export function LimitRangeDetails({ item, onNavigate }: QuotaDetailsProps) {
  const raw = item.raw ?? {};
  const spec = raw.spec ?? {};
  const limits: any[] = spec.limits ?? [];

  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />

      <KindSummary
        title={summaryTitle(item.kind)}
        icon={Ruler}
        tiles={[
          { label: 'Limit entries', value: limits.length || '—' },
          { label: 'Types', value: [...new Set(limits.map(limit => limit.type).filter(Boolean))].join(', ') || '—' },
        ]}
        rows={[
          { label: 'Container scoped', value: limits.some(limit => limit.container) ? 'Yes' : 'No' },
          { label: 'Pod scoped', value: limits.some(limit => limit.pod) ? 'Yes' : 'No' },
        ]}
      />

      <DetailsSection title="Container and pod limits" icon={Ruler}>
        <DetailTable
          columns={['Type', 'Scope', 'Default', 'Default request', 'Max', 'Min']}
          rows={limits.map(limit => [
            limit.type ?? '—',
            limit.container ?? (limit.pod ? 'Pod' : '—'),
            limit.default ?? '—',
            limit.defaultRequest ?? '—',
            limit.max ?? '—',
            limit.min ?? '—',
          ])}
          empty="This limit range does not define any limits."
        />
      </DetailsSection>

      <UsedByList item={item} onNavigate={onNavigate} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
