import { performResourceAction } from '../../../../providers/resource_actions';
import { resourceIcon } from '../../../../core/resource_icons';
import { useMemo, useState } from 'react';
import { RotateCw, RefreshCw } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { useResourceStore } from '../../../../state/resource_store';
import { useClusterStore } from '../../../../state/cluster_store';
import { k8s } from '../../../../providers/k8s_provider';
import { toast } from '../../../../state/notifications_store';
import { gitOpsFamily, gitOpsReferences, resolveGitOpsReference } from '../../../../core/resources/gitops';
import { fieldText, fieldValue, presentationFor } from '../../../../core/resources/resource_presentations';
import { summaryTitle } from '../../../../core/resources/kind_labels';
import { DetailsSection } from '../DetailsSection';
import { KindSummary } from '../blocks/KindSummary';
import { DetailTable } from '../blocks/DetailTable';
import { ReferenceRows } from '../blocks/ReferenceRows';
import { StructuredFields } from '../blocks/StructuredFields';
import { ConditionsTable } from '../blocks/ConditionsTable';
import { MetadataBlock } from '../blocks/MetadataBlock';
import { UsedByList } from '../blocks/UsedByList';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { Button } from '../../../ui/Button';
import { SearchInput } from '../../../ui/Input';
import { FluxHelmRetry } from '../../FluxHelmRetry';

/** Flux and Argo CD resources: reconciliation state, sources and managed objects. */
export function GitOpsDetails({ item, onNavigate }: { item: ResourceItem; onNavigate: (item: ResourceItem) => void }) {
  const resources = useResourceStore(state => state.resources);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(30);
  const all = useMemo(() => Object.values(resources).flatMap(map => [...map.values()]), [resources]);
  const references = useMemo(() => gitOpsReferences(item), [item]);
  const raw = item.raw ?? {};
  const presentation = presentationFor(item);
  const family = gitOpsFamily(item);
  const managed = references.managed.filter(ref => `${ref.kind} ${ref.name} ${ref.namespace ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const isArgoApp = family === 'argocd' && item.kind === 'Application';
  const [syncing, setSyncing] = useState(false);

  const handleSync = async () => {
    const currentContext = useClusterStore.getState().currentContext;
    if (!currentContext && !k8s.demo) {
      toast.error('No active cluster context');
      return;
    }
    setSyncing(true);
    const updatedRaw = { ...raw, operation: { sync: { prune: true } } };
    try {
      if (k8s.demo) {
        useResourceStore.getState().updateItem(item.kind, item.uid, { ...item, raw: updatedRaw });
        toast.success(`Sync requested for ${item.name} (demo)`);
      } else {
        await performResourceAction(currentContext!, item, { type: 'argo_sync' });
      }
    } catch (err: any) {
      if (err?.code === 'cancelled') toast.info('Sync cancelled');
      else toast.error('Sync failed', String(err?.message || err));
    } finally {
      setSyncing(false);
    }
  };

  const handleRefresh = async (hard = false) => {
    const currentContext = useClusterStore.getState().currentContext;
    if (!currentContext && !k8s.demo) {
      toast.error('No active cluster context');
      return;
    }
    const updatedRaw = {
      ...raw,
      metadata: {
        ...(raw.metadata ?? {}),
        annotations: {
          ...(raw.metadata?.annotations ?? {}),
          'argocd.argoproj.io/refresh': hard ? 'hard' : 'normal',
        },
      },
    };
    try {
      if (k8s.demo) {
        useResourceStore.getState().updateItem(item.kind, item.uid, { ...item, raw: updatedRaw });
        toast.success(`${hard ? 'Hard refresh' : 'Refresh'} requested for ${item.name} (demo)`);
      } else {
        await performResourceAction(currentContext!, item, { type: 'argo_refresh', hard });
      }
    } catch (err: any) {
      if (err?.code === 'cancelled') toast.info('Refresh cancelled');
      else toast.error('Refresh failed', String(err?.message || err));
    }
  };

  const health = raw.status?.health?.status ?? item.status ?? 'Not reported';
  const syncStatus = raw.status?.sync?.status ?? raw.status?.conditions?.find((condition: any) => condition.type === 'Ready')?.status ?? 'Not reported';

  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />

      <KindSummary
        title={summaryTitle(item.kind)}
        icon={resourceIcon(item.kind, item.apiVersion)}
        tiles={[
          { label: family === 'flux' ? 'Ready' : 'Health', value: health, tone: health === 'Ready' || health === 'Healthy' ? 'ok' : health === 'Not reported' ? 'muted' : 'warn' },
          { label: 'Sync status', value: syncStatus, tone: syncStatus === 'Synced' || syncStatus === 'True' ? 'ok' : 'muted' },
          { label: 'Revision', value: raw.status?.sync?.revision ?? raw.status?.artifact?.revision ?? '—', tone: 'muted' },
          { label: 'Suspended', value: raw.spec?.suspend === true ? 'Yes' : 'No', tone: raw.spec?.suspend === true ? 'warn' : 'muted' },
        ]}
        rows={[
          ...(presentation?.fields ?? []).map(field => ({
            label: field.label,
            value: fieldText(fieldValue(raw, field.path)) ?? '—',
          })),
          { label: 'Observed generation', value: `${raw.status?.observedGeneration ?? '—'} / ${raw.metadata?.generation ?? '—'}` },
        ]}
        footer={isArgoApp ? (
          <div className="details-actions-row">
            <Button size="sm" variant="primary" loading={syncing} disabled={syncing} onClick={handleSync}>
              <RotateCw size="calc(11px * var(--ui-factor))" />
              Sync
            </Button>
            <Button size="sm" variant="secondary" onClick={() => handleRefresh(false)}>
              <RefreshCw size="calc(11px * var(--ui-factor))" />
              Refresh
            </Button>
            <Button size="sm" variant="secondary" onClick={() => handleRefresh(true)}>
              <RefreshCw size="calc(11px * var(--ui-factor))" />
              Hard Refresh
            </Button>
          </div>
        ) : undefined}
      />

      {raw.status?.operationState?.message && (
        <DetailsSection title="Last operation">
          <p className="details-caption break-words">{raw.status.operationState.message}</p>
        </DetailsSection>
      )}

      <FluxHelmRetry key={`${item.uid}/${item.apiVersion}`} item={item} />
      <ConditionsTable conditions={raw.status?.conditions} />

      {!!references.sources.length && (
        <DetailsSection title="References">
          <ReferenceRows
            entries={references.sources.map(ref => ({
              kind: ref.kind,
              name: ref.name,
              namespace: ref.namespace,
              item: resolveGitOpsReference(ref, all),
              note: ref.local === false ? 'Other cluster' : undefined,
            }))}
            onNavigate={onNavigate}
          />
        </DetailsSection>
      )}

      {!!references.managed.length && (
        <DetailsSection title={`Managed resources (${references.managed.length})`}>
          <SearchInput aria-label="Find managed resources" placeholder="Find managed resources…" value={query} onChange={value => { setQuery(value); setLimit(30); }} />
          <DetailTable
            columns={['Kind', 'Name', 'Namespace', 'Group']}
            rows={managed.slice(0, limit).map(ref => {
              const target = resolveGitOpsReference(ref, all);
              return [
                ref.kind,
                target
                  ? <button type="button" className="details-link" onClick={() => onNavigate(target)}>{ref.name}</button>
                  : ref.name,
                ref.namespace ?? 'cluster',
                ref.group ?? '—',
              ];
            })}
          />
          {managed.length > limit && <Button size="sm" className="mt-2" onClick={() => setLimit(value => value + 30)}>Show next 30</Button>}
          {!managed.length && <p className="details-caption">No matching resources.</p>}
        </DetailsSection>
      )}

      {presentation?.sections?.map(section => <StructuredFields key={section.label} title={section.label} value={fieldValue(raw, section.path)} />)}
      <StructuredFields title="Last operation state" value={raw.status?.operationState} />
      <UsedByList item={item} onNavigate={onNavigate} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
