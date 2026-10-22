import type { ReactNode } from 'react';
import type { ResourceItem } from '../../../../types/k8s';
import { useResourceStore } from '../../../../state/resource_store';
import { resourceByRef } from '../../../../core/resources/detail_links';
import { summaryTitle } from '../../../../core/resources/kind_labels';
import { KIND_ICONS } from '../../../../core/perspectives';
import { KindSummary, type StatTile } from '../blocks/KindSummary';
import { StructuredFields } from '../blocks/StructuredFields';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { UsedByList } from '../blocks/UsedByList';
import { ConditionsTable } from '../blocks/ConditionsTable';
import { MetadataBlock } from '../blocks/MetadataBlock';
import { CrdInstances } from '../blocks/CrdInstances';

interface GenericResourceDetailsProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
}

/** Headline facts of the kinds that do not have a dedicated panel. */
function genericSummary(
  item: ResourceItem,
  resources: Record<string, Map<string, ResourceItem>>,
  onNavigate: (item: ResourceItem) => void,
): { tiles: StatTile[]; rows: { label: string; value: ReactNode }[] } {
  const raw = item.raw ?? {};
  const spec = raw.spec ?? item.spec ?? {};
  const status = raw.status ?? item.statusRaw ?? {};
  const metadata = raw.metadata ?? item.metadata ?? {};
  const tiles: StatTile[] = [];
  const rows: { label: string; value: ReactNode }[] = [];

  switch (item.kind) {
    case 'Namespace':
      tiles.push({ label: 'Phase', value: status.phase ?? 'Active', tone: status.phase === 'Active' ? 'ok' : 'warn' });
      tiles.push({ label: 'Finalizers', value: metadata.finalizers?.length ?? 0, tone: 'muted' });
      rows.push({ label: 'Scope', value: 'Cluster scoped' });
      break;
    case 'ServiceAccount':
      tiles.push({ label: 'Secrets', value: spec.secrets?.length ?? 0, tone: 'muted' });
      tiles.push({ label: 'Pull secrets', value: spec.imagePullSecrets?.length ?? 0, tone: 'muted' });
      rows.push({ label: 'Automount token', value: spec.automountServiceAccountToken === false ? 'Disabled' : 'Enabled' });
      break;
    case 'Role':
    case 'ClusterRole':
      tiles.push({ label: 'Rules', value: spec.rules?.length ?? 0 });
      tiles.push({ label: 'Aggregated roles', value: spec.aggregationRule?.clusterRoleSelectors?.length ?? 0, tone: 'muted' });
      break;
    case 'RoleBinding':
    case 'ClusterRoleBinding': {
      const roleRef = spec.roleRef ?? {};
      const role = roleRef.name
        ? resourceByRef(resources, { kind: roleRef.kind, name: roleRef.name, namespace: roleRef.kind === 'Role' ? item.namespace : undefined })
        : undefined;
      tiles.push({ label: 'Subjects', value: spec.subjects?.length ?? 0 });
      rows.push({
        label: 'Role',
        value: roleRef.name
          ? role
            ? <button type="button" className="details-link" onClick={() => onNavigate(role)}>{roleRef.kind}/{role.name}</button>
            : <span>{roleRef.kind}/{roleRef.name}</span>
          : '—',
      });
      rows.push({ label: 'Subject kinds', value: spec.subjects?.map((subject: any) => subject.kind).join(', ') || '—' });
      break;
    }
    case 'StorageClass':
      tiles.push({ label: 'Provisioner', value: spec.provisioner ?? '—', tone: 'info' });
      tiles.push({ label: 'Reclaim policy', value: spec.reclaimPolicy ?? 'Delete', tone: 'muted' });
      rows.push({ label: 'Volume binding', value: spec.volumeBindingMode ?? 'Immediate' });
      break;
    case 'CustomResourceDefinition': {
      const versions: any[] = spec.versions ?? [];
      tiles.push({ label: 'Group', value: spec.group ?? '—', tone: 'info' });
      tiles.push({ label: 'Kind', value: spec.names?.kind ?? '—' });
      tiles.push({ label: 'Scope', value: spec.scope ?? '—', tone: 'muted' });
      rows.push({ label: 'Versions', value: versions.map((version: any) => version.name).join(', ') || '—' });
      rows.push({ label: 'Storage version', value: versions.find((version: any) => version.storage)?.name ?? '—' });
      break;
    }
    case 'Event': {
      tiles.push({ label: 'Type', value: item.raw?.type ?? '—', tone: item.raw?.type === 'Warning' ? 'warn' : 'ok' });
      tiles.push({ label: 'Count', value: raw.count ?? 1, tone: 'muted' });
      rows.push({ label: 'Reason', value: raw.reason ?? '—' });
      rows.push({ label: 'Object', value: raw.involvedObject ? `${raw.involvedObject.kind}/${raw.involvedObject.name}` : '—' });
      rows.push({ label: 'Source', value: raw.source?.component ?? raw.reportingComponent ?? '—' });
      break;
    }
    default:
      break;
  }
  return { tiles, rows };
}

/** Objects without a dedicated panel: the same skeleton, raw fields as the last resort. */
export function GenericResourceDetails({ item, onNavigate }: GenericResourceDetailsProps) {
  const resources = useResourceStore(state => state.resources);
  const raw = item.raw ?? {};
  const spec = raw.spec ?? item.spec ?? {};
  const status = raw.status ?? item.statusRaw ?? {};
  const summary = genericSummary(item, resources, onNavigate);
  const icon = KIND_ICONS[item.kind];

  return (
    <div className="details-stack">
      {/* 1. "What's wrong" diagnostic banner */}
      <ProblemsBanner item={item} />

      {/* 2. Headline facts */}
      {(summary.tiles.length > 0 || summary.rows.length > 0) && (
        <KindSummary title={summaryTitle(item.kind)} icon={icon} tiles={summary.tiles} rows={summary.rows} />
      )}

      {/* 3. Raw fields */}
      <StructuredFields title="Specification" value={spec} />
      <StructuredFields title="Status" value={Object.fromEntries(Object.entries(status).filter(([key]) => key !== 'conditions'))} />
      <StructuredFields title="Resource fields" value={Object.fromEntries(Object.entries(raw).filter(([key]) => !['apiVersion', 'kind', 'metadata', 'spec', 'status'].includes(key)))} />

      {/* 4. Used By (Consumers) */}
      {item.kind === 'CustomResourceDefinition'
        ? <CrdInstances item={item} />
        : item.kind !== 'Event' && <UsedByList item={item} onNavigate={onNavigate} />}

      {/* 5. Conditions */}
      <ConditionsTable conditions={status.conditions} />

      {/* 6. Metadata */}
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
