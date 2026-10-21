import { Fragment, useMemo, useState } from 'react';
import { RotateCw, RefreshCw } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { useResourceStore } from '../../../../state/resource_store';
import { useClusterStore } from '../../../../state/cluster_store';
import { k8s } from '../../../../providers/k8s_provider';
import { stringify } from 'yaml';
import { toast } from '../../../../state/notifications_store';
import { gitOpsFamily, gitOpsReferences, resolveGitOpsReference } from '../../../../core/resources/gitops';
import { fieldText, fieldValue, presentationFor } from '../../../../core/resources/resource_presentations';
import { DetailsSection } from '../DetailsSection';
import { StructuredFields } from '../blocks/StructuredFields';
import { ConditionsTable } from '../blocks/ConditionsTable';
import { MetadataBlock } from '../blocks/MetadataBlock';
import { UsedByList } from '../blocks/UsedByList';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { Button } from '../../../ui/Button';
import { SearchInput } from '../../../ui/Input';

export function GitOpsDetails({ item, onNavigate }: { item: ResourceItem; onNavigate: (item: ResourceItem) => void }) {
  const resources = useResourceStore(state => state.resources);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(30);
  const all = useMemo(() => Object.values(resources).flatMap(map => [...map.values()]), [resources]);
  const references = useMemo(() => gitOpsReferences(item), [item]);
  const raw = item.raw ?? {};
  const presentation = presentationFor(item)!;
  const managed = references.managed.filter(ref => `${ref.kind} ${ref.name} ${ref.namespace ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const renderReference = (ref: typeof references.sources[number], index: number) => {
    const target = resolveGitOpsReference(ref, all);
    const label = `${ref.kind}/${ref.name}${ref.namespace ? ` · ${ref.namespace}` : ''}`;
    return target ? <button key={index} className="details-resource-row details-link break-all" onClick={() => onNavigate(target)}>{label}</button>
      : <div key={index} className="details-resource-row"><span className="min-w-0 break-all">{label}</span><span className="text-[var(--text-muted)] text-xs shrink-0">{ref.local === false ? 'Other cluster' : 'Not loaded'}</span></div>;
  };
  const isArgoApp = gitOpsFamily(item) === 'argocd' && item.kind === 'Application';
  const [syncing, setSyncing] = useState(false);

  const handleSync = async () => {
    const currentContext = useClusterStore.getState().currentContext;
    if (!currentContext && !k8s.demo) {
      toast.error('No active cluster context');
      return;
    }
    setSyncing(true);
    const updatedRaw = {
      ...raw,
      operation: {
        sync: {
          prune: true,
        },
      },
    };
    try {
      if (k8s.demo) {
        useResourceStore.getState().updateItem(item.kind, item.uid, { ...item, raw: updatedRaw });
        toast.success(`Sync requested for ${item.name} (demo)`);
      } else {
        await k8s.applyManifest(currentContext!, stringify(updatedRaw), item);
        toast.success(`Sync requested for ${item.name}`);
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
        await k8s.applyManifest(currentContext!, stringify(updatedRaw), item);
        toast.success(`${hard ? 'Hard refresh' : 'Refresh'} requested for ${item.name}`);
      }
    } catch (err: any) {
      if (err?.code === 'cancelled') toast.info('Refresh cancelled');
      else toast.error('Refresh failed', String(err?.message || err));
    }
  };

  return <div className="details-stack">
    <ProblemsBanner item={item} />
    <DetailsSection title={gitOpsFamily(item) === 'flux' ? 'Reconciliation' : 'Sync & health'}>
      {isArgoApp && (
        <div className="flex items-center gap-2 mb-2 pb-2 border-b border-[var(--border-subtle)]">
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
      )}
      <dl className="details-properties">
        <dt>Status</dt><dd>{item.status ?? 'Not reported'}</dd>
        {presentation.fields.map(field => <Fragment key={field.label}><dt>{field.label}</dt><dd>{fieldText(fieldValue(raw, field.path)) ?? '—'}</dd></Fragment>)}
        <dt>Observed generation</dt><dd>{raw.status?.observedGeneration ?? '—'} / {raw.metadata?.generation ?? '—'}</dd>
      </dl>
      {raw.status?.operationState?.message && <p className="text-xs break-words mt-2">{raw.status.operationState.message}</p>}
    </DetailsSection>
    <ConditionsTable conditions={raw.status?.conditions} />
    {!!references.sources.length && <DetailsSection title="References">{references.sources.map(renderReference)}</DetailsSection>}
    {!!references.managed.length && <DetailsSection title={`Managed resources (${references.managed.length})`}>
      <SearchInput aria-label="Find managed resources" placeholder="Find managed resources…" value={query} onChange={value => { setQuery(value); setLimit(30); }} />
      {managed.slice(0, limit).map(renderReference)}
      {managed.length > limit && <Button size="sm" onClick={() => setLimit(value => value + 30)}>Show next 30</Button>}
      {!managed.length && <p className="text-xs text-[var(--text-muted)]">No matching resources.</p>}
    </DetailsSection>}
    {presentation.sections?.map(section => <StructuredFields key={section.label} title={section.label} value={fieldValue(raw, section.path)} />)}
    <StructuredFields title="Last operation" value={raw.status?.operationState} />
    <UsedByList item={item} onNavigate={onNavigate} />
    <MetadataBlock item={item} onNavigate={onNavigate} />
  </div>;
}
