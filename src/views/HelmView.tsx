import { CodeEditor } from '../components/ui/CodeEditor';
import { ResourceView } from './ResourceView';
import { HelmOverview } from './HelmOverview';
import type { ColumnFilters } from '../core/resources/column_filters';
import { FluxHelmRetry } from '../components/k8s/FluxHelmRetry';
import { resourceBucket } from '../core/resources/custom_resource_types';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Anchor, Copy, RefreshCw, GitBranch, ArrowUpCircle, RotateCcw, Trash2, MoreHorizontal, Package, Boxes, FileCode, Plus } from 'lucide-react';
import { useClusterStore } from '../state/cluster_store';
import { k8s } from '../providers/k8s_provider';
import { normalizeK8sError, type K8sRequestError } from '../providers/errors';
import { helmStatusTone, type HelmDocument, type HelmHistory, type HelmRelease, type HelmSection } from '../providers/helm_types';
import { Button, DataTable, FixedMenu, IconButton, MenuList, Popover, ResourceLoading, SearchInput, type MenuItem } from '../components/ui';
import { RequestErrorNotice } from '../components/k8s/RequestErrorNotice';
import { toast } from '../state/notifications_store';
import { HelmActionDialog, type HelmAction } from '../components/dialogs/HelmActionDialog';
import { useResourceStore } from '../state/resource_store';
import { retainResourceKinds } from '../state/resource_requirements';
import { useWorkspaceStore } from '../state/workspace_store';
import { helmResource } from '../core/resources/helm';
import type { ResourceItem } from '../types/k8s';
import { DetailsPanel } from '../components/k8s/details/DetailsPanel';
import { DetailsSection } from '../components/k8s/details/DetailsSection';
import { ResourceKindBadge } from '../components/k8s/ResourceKindBadge';
import { Fragment } from 'react';
import type { ResourceDetailsProps } from '../components/layout/InspectorPanel';
import { useTableViewStore } from '../state/table_view_store';
import { cacheHelmReleases, inspectHelmRelease } from '../state/helm_resources';
import { subscribeHelmChanges } from '../providers/use_helm_graph';
import { useUiStore } from '../state/ui_store';
import { useHelmInventory } from '../providers/use_helm_inventory';
import { useFluxHelmOwners } from '../providers/use_flux_helm_owners';
import { fluxReleaseOwner, helmOperation, parseReleaseManifest, releaseDiagnosticObjects, releaseHealth, releaseObjects } from '../core/resources/helm_diagnostics';
import { deliveryActivity } from '../core/resources/delivery_activity';
import { resourceIssues } from '../core/resources/diagnostics';
import { namespaceScopeCovers } from '../core/resources/namespace_scope';
import { refreshResourceWatches } from '../state/resource_watch';
import './helm.css';
import './delivery.css';

/** Each response belongs to one scope. Old results can never replace another target. */
function useHelmRead<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>) {
  const reader = useRef(load); reader.current = load;
  const [epoch, retry] = useState(0);
  useEffect(() => subscribeHelmChanges(() => retry(value => value + 1)), []);
  const [state, setState] = useState<{ key: string | null; data: T | null; loading: boolean; error: K8sRequestError | null }>({ key: null, data: null, loading: false, error: null });
  useEffect(() => {
    if (key === null) return;
    const abort = new AbortController();
    setState(previous => ({ key, data: previous.key === key ? previous.data : null, loading: true, error: null }));
    void reader.current(abort.signal).then(data => {
      if (!abort.signal.aborted) setState({ key, data, loading: false, error: null });
    }, error => {
      if (!abort.signal.aborted) setState(previous => ({ key, data: previous.key === key ? previous.data : null, loading: false, error: normalizeK8sError(error, { operation: 'helm' }) }));
    });
    return () => abort.abort();
  }, [key, epoch]);
  const current = state.key === key ? state : { data: null, loading: key !== null, error: null };
  return { ...current, refresh: () => retry(value => value + 1) };
}

const releaseKey = (release: HelmRelease) => JSON.stringify([release.namespace, release.name, release.revision]);
const helmDocumentCache = new Map<string, string>();
const inFlightHelmDocuments = new Map<string, { promise: Promise<string>; controller: AbortController; waiters: number }>();
subscribeHelmChanges(() => {
  helmDocumentCache.clear();
  for (const entry of inFlightHelmDocuments.values()) entry.controller.abort();
  inFlightHelmDocuments.clear();
});

async function readHelmDocument(context: string, namespace: string, name: string, revision: number, document: HelmDocument, signal: AbortSignal): Promise<string> {
  const key = JSON.stringify([context, namespace, name, revision, document]);
  const cached = helmDocumentCache.get(key);
  if (cached !== undefined) return cached;

  let entry = inFlightHelmDocuments.get(key);
  if (!entry) {
    const controller = new AbortController();
    const promise = k8s.getHelmContent(context, namespace, name, revision, document, controller.signal).then(content => {
      helmDocumentCache.set(key, content);
      if (helmDocumentCache.size > 64) helmDocumentCache.delete(helmDocumentCache.keys().next().value!);
      return content;
    }).finally(() => {
      if (inFlightHelmDocuments.get(key) === entry) inFlightHelmDocuments.delete(key);
    });
    entry = { promise, controller, waiters: 0 };
    inFlightHelmDocuments.set(key, entry);
  }
  entry.waiters++;

  return new Promise<string>((resolve, reject) => {
    const onAbort = () => {
      entry.waiters--;
      // Defer aborting the shared fetch by a microtask so React StrictMode remounts or
      // concurrent panes reading the same revision document reuse the single in-flight request.
      queueMicrotask(() => {
        if (entry.waiters <= 0 && inFlightHelmDocuments.get(key) === entry) {
          inFlightHelmDocuments.delete(key);
          entry.controller.abort();
        }
      });
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    entry.promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        entry.waiters--;
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        entry.waiters--;
        reject(error);
      },
    );
  });
}

export function HelmView({ section }: { section: HelmSection }) {
  const context = useClusterStore(state => state.currentContext);
  const scope = useClusterStore(state => state.selectedNamespace);
  if (section === 'repositories') return <HelmRepositories />;
  if (!context) return <div className="p-6 text-[var(--text-secondary)]">Select a cluster to view Helm releases.</div>;
  const namespace = section === 'overview' || scope === 'all' ? null : scope;
  return <HelmReleases key={JSON.stringify([context, namespace])} context={context} namespace={namespace} overview={section === 'overview'} />;
}

function HelmReleases({ context, namespace, overview }: { context: string; namespace: string | null; overview: boolean }) {
  const [action, setAction] = useState<{ action: HelmAction; release?: HelmRelease } | null>(null);
  const result = useHelmInventory(context, namespace);
  const resources = useResourceStore(state => overview ? null : state.resources);
  const rows = useMemo(() => {
    if (!resources) return [];
    const observed = new Map<string, { loaded: number; issues: number }>();
    for (const [kind, bucket] of Object.entries(resources)) {
      if (kind === 'Event' || kind === 'HelmRelease') continue;
      for (const item of bucket.values()) {
        const metadata = item.raw?.metadata ?? item.metadata ?? {};
        if (metadata.labels?.['app.kubernetes.io/managed-by'] !== 'Helm') continue;
        const name = metadata.annotations?.['meta.helm.sh/release-name'];
        const ns = metadata.annotations?.['meta.helm.sh/release-namespace'];
        if (!name || !ns) continue;
        const key = `${ns}/${name}`;
        const value = observed.get(key) ?? { loaded: 0, issues: 0 };
        value.loaded++; if (resourceIssues(item).length) value.issues++;
        observed.set(key, value);
      }
    }
    return (result.data ?? []).map(release => {
      const item = helmResource(context, release);
      const value = observed.get(`${release.namespace}/${release.name}`);
      return { ...item, raw: { ...item.raw, observedHealth: !value ? 'Not loaded' : value.issues ? `${value.issues} with issues / ${value.loaded} loaded` : `${value.loaded} loaded · no issues` } };
    });
  }, [context, result.data, resources]);
  useEffect(() => { if (result.data) cacheHelmReleases(context, result.data); }, [context, result.data]);
  const openReleases = (columnFilters: ColumnFilters = {}) => {
    if (overview) useClusterStore.getState().selectNamespace('all');
    useTableViewStore.getState().update('kind:HelmRelease', { searchQuery: '', columnFilters });
    useWorkspaceStore.getState().openHelm('releases');
  };
  const notice = <>
    {!!result.partialErrors.length && <details className="mx-3 mt-2 rounded border border-[var(--status-warn)]/40 p-2.5 text-xs">
      <summary>Partial release data · {result.partialErrors.length} namespace(s) unavailable (loaded releases are shown below)</summary>
      <ul>{result.partialErrors.map(entry => <li key={entry.scope}><strong>{entry.scope}</strong>: {entry.error.message}</li>)}</ul>
    </details>}
  </>;
  const install = <Button size="sm" aria-label="Install release" disabled={!k8s.supportsHelmMutations} onClick={() => setAction({ action: 'install' })}><Plus size={13} aria-hidden="true" />Install release</Button>;
  return <section aria-label={overview ? 'Helm overview' : 'Helm releases'} data-testid={overview ? 'helm-overview' : 'helm-releases'} aria-busy={result.loading} className="helm-workspace">
    {overview ? <>
      {result.error && <RequestErrorNotice error={result.error} onRetry={result.refresh} retainedData={!!result.data} />}
      {notice}
      <HelmOverview context={context} releases={result.data ?? null} updated={result.updated} loading={result.loading} partial={result.partialErrors.length > 0} stale={!!result.error}
        actions={<><Button size="sm" onClick={() => openReleases()}>View releases</Button>{install}<IconButton icon={RefreshCw} size="sm" disabled={result.loading} onClick={result.refresh} aria-label="Refresh Helm releases" /></>}
        onBrowse={openReleases} onInspect={release => inspectHelmRelease(context, release)} />
    </> : <ResourceView explicitKind="HelmRelease" source={{
      items: rows, loading: result.loading, error: result.error, label: 'Helm Releases', refresh: result.refresh, toolbar: install, notice,
      rowLabel: item => `Inspect Helm release ${item.name} in ${item.namespace}`,
      rowMenu: item => [
        { id: 'inspect', label: 'Inspect release', onSelect: () => inspectHelmRelease(context, item.raw!.release) },
        { id: 'open', label: 'Open in Dedicated Tab', onSelect: () => useWorkspaceStore.getState().openResourceDetail(item) },
        { id: 'topology', label: 'Open Helm topology', onSelect: () => openHelmTopology(context, item.raw!.release) },
        ...(['upgrade', 'rollback', 'uninstall'] as const).map(operation => ({ id: operation, label: operation === 'rollback' ? 'Roll back…' : operation === 'uninstall' ? 'Uninstall…' : 'Upgrade…', danger: operation === 'uninstall', disabled: !k8s.supportsHelmMutations, onSelect: () => setAction({ action: operation, release: item.raw!.release }) })),
      ],
    }} />}
    {action && <HelmActionDialog action={action.action} release={action.release} onClose={() => setAction(null)} onCompleted={() => {
      if (action.action === 'uninstall' && action.release) {
        const uid = helmResource(context, action.release).uid;
        const store = useResourceStore.getState();
        if (store.selectedItem?.uid === uid) useUiStore.setState({ inspectorCollapsed: true });
        store.deleteItem('HelmRelease', uid);
      }
    }} />}
  </section>;
}

function Status({ status }: { status: string }) {
  return <span title={status} className={`inline-flex items-center gap-1.5 ${helmStatusTone(status)}`}><span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" aria-hidden="true" />{status}</span>;
}

type HelmDetailTab = 'overview' | 'history' | HelmDocument;
const helmDetailTabs = [
  { id: 'overview', label: 'Overview' }, { id: 'history', label: 'History' },
  { id: 'values', label: 'Values' }, { id: 'manifest', label: 'Manifest' }, { id: 'hooks', label: 'Hooks' }, { id: 'notes', label: 'Notes' },
] as const;

export function HelmReleaseDetails({ item, inspector, onClose, onBack, backTarget, onNavigate }: ResourceDetailsProps & { item: ResourceItem }) {
  const context = useClusterStore(state => state.currentContext)!;
  useEffect(() => item.namespace ? retainResourceKinds(context, ['Pod', 'ReplicaSet', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'Service', 'Ingress', 'PersistentVolumeClaim'], item.namespace) : undefined, [context, item.namespace]);
  const resources = useResourceStore(state => state.resources);
  const history = useHelmRead(JSON.stringify([context, item.namespace, item.name, 'history']), signal => k8s.getHelmHistory(context, item.namespace!, item.name, signal));
  const latest = history.data?.reduce<HelmHistory | undefined>((current, row) => !current || row.revision > current.revision ? row : current, undefined);
  const original = item.raw?.release as HelmRelease | undefined;
  const release: HelmRelease | undefined = latest ? { name: item.name, namespace: item.namespace!, revision: String(latest.revision), updated: latest.updated, status: latest.status, chart: latest.chart, app_version: latest.app_version } : original;
  useEffect(() => { if (latest) cacheHelmReleases(context, [{ name: item.name, namespace: item.namespace!, revision: String(latest.revision), updated: latest.updated, status: latest.status, chart: latest.chart, app_version: latest.app_version }]); }, [context, item.name, item.namespace, latest]);
  const [action, setAction] = useState<{ kind: HelmAction; revision?: number } | null>(null);
  const [selection, setSelection] = useState<{ key: string; tab: HelmDetailTab; revision?: number }>({ key: item.uid, tab: 'overview' });
  const current = selection.key === item.uid ? selection : { key: item.uid, tab: 'overview' as const };
  const tab = current.tab;
  const revision = current.revision ?? Number(release?.revision);
  const setTab = (tab: HelmDetailTab) => setSelection({ ...current, tab });
  const chooseRevision = (revision: number) => { setSelection({ key: item.uid, tab: 'values', revision }); };
  const loadedResources = useMemo(() => Object.entries(resources).flatMap(([kind, map]) => kind === 'Event' ? [] : [...map.values()]), [resources]);
  const events = useMemo(() => [...resources.Event.values()], [resources.Event]);
  const managed = useMemo(() => releaseObjects({ name: item.name, namespace: item.namespace ?? '' }, loadedResources), [loadedResources, item.name, item.namespace]);
  const navigate = (next: ResourceItem) => {
    const store = useResourceStore.getState();
    const bucket = resourceBucket(next);
    const existing = store.resources[bucket]?.get(next.uid);
    if (!existing) store.setResourcesForKind(bucket, [...(store.resources[bucket]?.values() ?? []), next]);
    setTab('overview'); onNavigate(existing ?? next);
  };
  const owners = useFluxHelmOwners(context, null);
  const owner = fluxReleaseOwner({ name: item.name, namespace: item.namespace! }, owners.items);
  const canChange = k8s.supportsHelmMutations && !!release && !history.loading && !history.error;
  return <DetailsPanel busy={history.loading} busyLabel="Refreshing release…" item={item} inspector={inspector} onClose={onClose} onBack={onBack} backTarget={backTarget} onNavigate={navigate}
    rightTab={tab} setTab={setTab} tabs={helmDetailTabs}
    copyActions={[{ label: 'Release name', value: item.name }, { label: 'Namespace', value: item.namespace ?? '' }]}
    actions={<>
      <Button size="sm" aria-label="Upgrade" title="Upgrade release" disabled={!canChange} onClick={() => setAction({ kind: 'upgrade' })}><ArrowUpCircle size={13} aria-hidden="true" /><span className="details-action-label">Upgrade</span></Button>
      <Button size="sm" aria-label="Topology" title="Open topology" onClick={() => useWorkspaceStore.getState().openTopology(item)}><GitBranch size={13} aria-hidden="true" /><span className="details-action-label">Topology</span></Button>
      <IconButton icon={RefreshCw} size="sm" disabled={history.loading} onClick={history.refresh} aria-label="Refresh release" tooltip="Refresh release" />
      <Popover align="end" width={190} trigger={() => <IconButton icon={MoreHorizontal} size="sm" aria-label="More release actions" aria-haspopup="menu" tooltip="More release actions" />}>
        {close => <div role="menu" aria-label="Release actions"><MenuList autoFocus items={[
          { id: 'rollback', label: 'Roll back', icon: RotateCcw, disabled: !canChange || Number(release?.revision) <= 1, onSelect: () => setAction({ kind: 'rollback' }) },
          { id: 'uninstall', label: 'Uninstall', icon: Trash2, danger: true, disabled: !canChange, onSelect: () => setAction({ kind: 'uninstall' }) },
        ]} onSelect={action => { close(); action.onSelect?.(); }} /></div>}
      </Popover>
    </>}
    footer={action && release && <HelmActionDialog key={`${item.uid}/${action.kind}/${action.revision ?? ''}`} action={action.kind} initialRevision={action.revision} release={release} onClose={() => setAction(null)} onCompleted={() => {
      if (action.kind === 'uninstall') { useResourceStore.getState().deleteItem('HelmRelease', item.uid); onClose?.(); }
    }} />}>
    <div className={`details-scroll kubiki-scrollbar helm-detail-content ${tab !== 'overview' && tab !== 'history' ? 'helm-document-scroll' : ''}`}>
      {history.error && tab !== 'history' && <RequestErrorNotice error={history.error} onRetry={history.refresh} retainedData={!!release} />}
      {history.loading && !release && tab !== 'history' && <ResourceLoading label="Loading release revision…" />}
      {!history.loading && !history.error && !release && tab !== 'history' && <p role="status" className="p-3 text-xs text-[var(--text-secondary)]">No release revision is available. Refresh or choose another release.</p>}
      {tab === 'history' ? <HelmHistoryPane result={history} release={release} onSelect={chooseRevision} canRestore={canChange} onRestore={revision => setAction({ kind: 'rollback', revision })} />
        : release && tab === 'overview' ? <div className="details-body details-stack">
          {owner && <DetailsSection title="Managed by Flux"><p className="details-caption">Direct Helm operations are available. Flux may restore its declared state or reinstall an uninstalled release.</p><button className="details-resource-row" onClick={() => navigate(owner)}>{owner.namespace}/{owner.name}</button><FluxHelmRetry key={owner.uid} item={owner} onRequested={owners.refresh} /></DetailsSection>}
          {owners.error && <RequestErrorNotice error={owners.error} onRetry={owners.refresh} retainedData={!!owners.items.length} />}
          <ReleaseEvidence key={`${context}/${item.uid}/${release.revision}`} context={context} release={release} history={history.data ?? []} resources={loadedResources} events={events} onNavigate={navigate} />
          <DetailsSection title="Latest release snapshot" label="Release overview" icon={Package}>
            <dl className="details-properties">{[['Status', <Status key="status" status={release.status} />], ['Chart', release.chart], ['App version', release.app_version || '—'], ['Revision', release.revision], ['Updated', release.updated || '—'], ['Namespace', release.namespace], ['Context', context]].map(([label, value]) => <Fragment key={String(label)}><dt>{label}</dt><dd>{value}</dd></Fragment>)}</dl>
          </DetailsSection>
          <DetailsSection title={`Managed Kubernetes objects (${managed.length} loaded)`} label="Managed Kubernetes objects" icon={Boxes}>
            <p className="details-caption mb-1">Objects with Helm ownership annotations in the loaded scope.</p>
            {managed.slice(0, 50).map(resource => <button key={resource.uid} className="details-resource-row" aria-label={`Inspect ${resource.kind} ${resource.name} in ${resource.namespace ?? 'cluster'}`} onClick={() => navigate(resource)}>
              <ResourceKindBadge kind={resource.kind} apiVersion={resource.apiVersion} /><span className="details-resource-name" title={resource.name}>{resource.name}</span><span className="details-resource-namespace">{resource.namespace || 'cluster'}</span>
            </button>)}
            {!managed.length && <p className="details-caption">No managed objects loaded.</p>}
            {managed.length > 50 && <p className="details-caption">First 50 objects shown. Open topology for more.</p>}
          </DetailsSection>
        </div> : release && tab !== 'overview' ? <HelmDocumentPane key={`${context}/${item.uid}/${revision}/${tab}`} context={context} release={release} revision={revision} document={tab} onLatest={() => setSelection({ key: item.uid, tab })} /> : null}
    </div>
  </DetailsPanel>;
}

function HelmHistoryPane({ result, release, onSelect, onRestore, canRestore }: { canRestore: boolean; result: ReturnType<typeof useHelmRead<HelmHistory[]>>; release?: HelmRelease; onSelect: (revision: number) => void; onRestore: (revision: number) => void }) {
  const rows = [...(result.data ?? [])].sort((a, b) => b.revision - a.revision);
  return <div className="details-body details-stack">
    {result.loading && !result.data && <ResourceLoading label="Loading history…" />}
    {result.error && <RequestErrorNotice error={result.error} onRetry={result.refresh} retainedData={!!result.data} />}
    {result.data && <DetailsSection title="Revision history">
      <p className="details-caption mb-1">Inspect values or restore a revision. Restoring creates a new revision.</p>
      <DataTable
        ariaLabel="Helm release history"
        tableClassName="helm-table helm-history"
        rows={rows}
        rowKey={(row) => row.revision}
        empty={<p className="details-empty">No revision history available.</p>}
        columns={[
          {
            id: 'rev',
            header: 'Rev.',
            mono: true,
            cell: (row) => <>{row.revision}<span className="helm-history-current">{row.revision === Number(release?.revision) ? 'Current' : '\u00a0'}</span></>,
          },
          { id: 'status', header: 'Status', cell: (row) => <Status status={row.status} /> },
          {
            id: 'chart',
            header: 'Chart',
            cell: (row) => <><span className="helm-history-chart" title={row.chart}>{row.chart}</span><span className="helm-history-status-compact"><Status status={row.status} /></span><span className="helm-history-description" title={row.description}>{row.description || '\u00a0'}</span></>,
          },
          { id: 'updated', header: 'Updated', cell: (row) => <span title={row.updated}>{row.updated}</span> },
          {
            id: 'actions',
            header: <span className="sr-only">Actions</span>,
            cell: (row) => (
              <div className="helm-history-actions">
                <IconButton icon={FileCode} size="sm" aria-label={`Inspect Helm revision ${row.revision}`} tooltip={`Values for revision ${row.revision}`} onClick={() => onSelect(row.revision)} />
                <IconButton icon={RotateCcw} size="sm" disabled={!canRestore || row.revision === Number(release?.revision) || !k8s.supportsHelmMutations || !!result.error || result.loading} aria-label={`Restore Helm revision ${row.revision}`} tooltip={`Restore revision ${row.revision}`} onClick={() => onRestore(row.revision)} />
              </div>
            ),
          },
        ]}
      />
    </DetailsSection>}
  </div>;
}

function HelmDocumentPane({ context, release, revision, document, onLatest }: { context: string; release: HelmRelease; revision: number; document: HelmDocument; onLatest: () => void }) {
  const result = useHelmRead(JSON.stringify([context, releaseKey(release), revision, document]), signal => readHelmDocument(context, release.namespace, release.name, revision, document, signal));
  const title = <span className="helm-document-title details-caption">{document} · revision {revision}</span>;
  const actions = <>
    <IconButton icon={RotateCcw} size="sm" disabled={revision === Number(release.revision)} onClick={onLatest} aria-label="Latest revision" tooltip="Latest revision" />
    <IconButton icon={Copy} size="sm" disabled={result.data === null} aria-label={`Copy Helm ${document}`} tooltip={`Copy ${document}`} onClick={() => { void navigator.clipboard.writeText(result.data!).then(() => toast.success('Copied')).catch(() => toast.error('Clipboard unavailable')); }} />
  </>;
  return <div className="helm-document-pane" aria-busy={result.loading}>
    {result.error && <RequestErrorNotice error={result.error} onRetry={result.refresh} retainedData={result.data !== null} />}
    {result.data === null ? <>
      <div className="helm-document-toolbar">{title}{actions}</div>
      <div role="status" className="details-loading">{result.loading ? <ResourceLoading label={`Loading ${document}…`} /> : `No ${document} available.`}</div>
    </> : <CodeEditor key={JSON.stringify([context, releaseKey(release), revision, document])} ariaLabel={`Helm ${document} revision ${revision}`} value={result.data} language={document === 'notes' ? 'plaintext' : 'yaml'} readOnly fill variant="document" copyable={false} toolbarLeading={title} toolbarTrailing={actions} />}
  </div>;
}

function HelmRepositories() {
  const [action, setAction] = useState<{ action: HelmAction; repo?: import('../providers/helm_types').HelmRepo } | null>(null);
  const [menu, setMenu] = useState<{ repo: import('../providers/helm_types').HelmRepo; x: number; y: number } | null>(null);
  const [query, setQuery] = useState('');
  const result = useHelmRead('helm-repositories', signal => k8s.getHelmRepositories(signal));
  const rows = result.data?.filter(repo => repo.name.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  const displayUrl = (url: string) => { try { const value = new URL(url); if (value.username || value.password) { value.username = 'redacted'; value.password = ''; } return value.toString(); } catch { return url; } };
  return <section aria-label="Helm repositories" data-testid="helm-repositories" aria-busy={result.loading} className="helm-workspace"><div className="helm-toolbar"><h1><Anchor size={15} aria-hidden="true" />Repositories</h1>
    <Button size="sm" aria-label="Add repository" title="Add repository" disabled={!k8s.supportsHelmMutations} onClick={() => setAction({ action: 'repository_set' })}><Plus size={13} aria-hidden="true" /><span className="helm-action-label">Add repository</span></Button>
    <Popover align="end" width={190} trigger={() => <IconButton icon={MoreHorizontal} size="sm" aria-label="More repository actions" aria-haspopup="menu" tooltip="More repository actions" />}>
      {close => <div role="menu" aria-label="Repository actions"><MenuList autoFocus items={[{ id: 'update', label: 'Update indexes', disabled: !k8s.supportsHelmMutations, onSelect: () => setAction({ action: 'repository_update' }) }]} onSelect={action => { close(); action.onSelect?.(); }} /></div>}
    </Popover>
    <IconButton icon={RefreshCw} size="sm" disabled={result.loading} onClick={result.refresh} aria-label="Refresh Helm repositories" tooltip="Refresh repositories" />
    </div><div className="helm-filterbar"><SearchInput size="sm" className="helm-search flex-1 min-w-0" clearable={false} ariaLabel="Search Helm repositories by name" placeholder="Filter repositories…" value={query} onChange={setQuery} /></div><p className="helm-scope">{k8s.demo ? 'Demo · ' : ''}Local Helm configuration · Shared across clusters · {k8s.supportsHelmMutations ? 'Backend-confirmed changes' : 'Read only'}</p>{result.error && <RequestErrorNotice error={result.error} onRetry={result.refresh} retainedData={!!result.data} />}{result.loading && !result.data && <ResourceLoading label="Loading repositories…" />}{result.data && <DataTable
      className="helm-table-scroll"
      tableClassName="helm-table helm-repo-table"
      ariaLabel="Helm repository list"
      rows={rows}
      rowKey={(repo) => repo.name}
      rowTabIndex={0}
      rowAriaLabel={(repo) => `Helm repository ${repo.name}`}
      onRowContextMenu={(repo, _, event) => { event.preventDefault(); setMenu({ repo, x: event.clientX, y: event.clientY }); }}
      empty={<p role="status" className="p-6 text-[var(--text-secondary)]">{result.data.length ? 'No repositories match this name.' : 'No repositories configured in the local Helm CLI.'}</p>}
      columns={[
        { id: 'name', header: 'Name', mono: true, cell: (repo) => repo.name },
        { id: 'url', header: 'URL', cellClassName: 'break-all', cell: (repo) => displayUrl(repo.url) },
      ]}
    />}{menu && <FixedMenu rect={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} items={([
    { id: 'edit', label: 'Edit repository…', disabled: !k8s.supportsHelmMutations, onSelect: () => setAction({ action: 'repository_set', repo: menu.repo }) },
    { id: 'update', label: 'Update cached index…', disabled: !k8s.supportsHelmMutations, onSelect: () => setAction({ action: 'repository_update', repo: menu.repo }) },
    { id: 'remove', label: 'Remove repository…', danger: true, disabled: !k8s.supportsHelmMutations, onSelect: () => setAction({ action: 'repository_remove', repo: menu.repo }) },
  ] satisfies MenuItem[])} />}{action && <HelmActionDialog action={action.action} repo={action.repo} onClose={() => setAction(null)} onCompleted={result.refresh} />}</section>;
}


function openHelmTopology(context: string, release: HelmRelease) {
  const item = helmResource(context, release);
  const previous = [...useResourceStore.getState().resources.HelmRelease.values()].filter(value => value.name !== item.name || value.namespace !== item.namespace);
  useResourceStore.getState().setResourcesForKind('HelmRelease', [...previous.slice(-249), item]);
  useWorkspaceStore.getState().openTopology(item);
}

function ReleaseEvidence({ context, release, history, resources, events, onNavigate }: { context: string; release: HelmRelease; history: HelmHistory[]; resources: ResourceItem[]; events: ResourceItem[]; onNavigate: (item: ResourceItem) => void }) {
  const revision = Number(release.revision);
  const operation = helmOperation(release, history);
  const [requested, setRequested] = useState(false);
  const active = operation.pending || operation.failed || requested;
  const result = useHelmRead(active ? JSON.stringify([context, releaseKey(release), revision, 'evidence']) : null, async signal => {
    const [manifest, hooks] = await Promise.allSettled(['manifest', 'hooks'].map(document => readHelmDocument(context, release.namespace, release.name, revision, document as HelmDocument, signal)));
    const parse = (value: PromiseSettledResult<string>) => value.status === 'fulfilled' ? parseReleaseManifest(value.value, release.namespace) : [];
    return { objects: parse(manifest), hooks: parse(hooks), manifestError: manifest.status === 'rejected' ? normalizeK8sError(manifest.reason) : undefined, hookError: hooks.status === 'rejected' ? normalizeK8sError(hooks.reason) : undefined };
  });
  const health = useMemo(() => releaseHealth(result.data?.objects ?? [], resources), [result.data?.objects, resources]);
  const hooks = useMemo(() => releaseHealth(result.data?.hooks ?? [], resources), [result.data?.hooks, resources]);
  const targets = useMemo(() => releaseDiagnosticObjects(release, [...(result.data?.objects ?? []), ...(result.data?.hooks ?? [])], resources), [release, result.data, resources]);
  const eventNamespaces = useMemo(() => [...new Set([release.namespace, ...targets.flatMap(item => item.namespace ? [item.namespace] : [])])].sort(), [release.namespace, targets]);
  const eventWatch = useResourceStore(state => state.watchStates.Event);
  const watchCoversEvents = Boolean(
    eventWatch?.hasSnapshot
    && eventWatch.query.context === context
    && eventNamespaces.every(ns => namespaceScopeCovers(eventWatch.query.namespace ?? 'all', ns))
  );
  const activity = useHelmRead(
    watchCoversEvents ? null : JSON.stringify([context, releaseKey(release), 'events', eventNamespaces]),
    async signal => {
      const results = await Promise.allSettled(
        eventNamespaces.map(namespace => k8s.getResources(context, 'Event', namespace, signal, { priority: 'low' })),
      );
      return {
        events: results.flatMap(result => result.status === 'fulfilled' ? result.value : []),
        errors: results.flatMap((result, index) => result.status === 'rejected' ? [{ namespace: eventNamespaces[index], error: normalizeK8sError(result.reason) }] : []),
      };
    },
  );
  const activeEvents = watchCoversEvents ? events : (activity.data?.events ?? events);
  const relatedEvents = useMemo(() => deliveryActivity(activeEvents, targets), [activeEvents, targets]);
  const hookEventsByUid = useMemo(() => {
    const hookItems = hooks.slice(0, 50).flatMap(row => row.item ? [row.item] : []);
    const byUid = new Map<string, ReturnType<typeof deliveryActivity>>();
    if (!hookItems.length) return byUid;
    for (const entry of deliveryActivity(activeEvents, hookItems)) {
      const list = byUid.get(entry.item.uid);
      if (list) list.push(entry);
      else byUid.set(entry.item.uid, [entry]);
    }
    return byUid;
  }, [activeEvents, hooks]);
  return <>
    {(operation.pending || operation.failed) && <DetailsSection title={operation.label}><p role={operation.failed ? 'alert' : 'status'} className="details-caption whitespace-pre-wrap break-words">{operation.message}</p>{operation.started > 0 && <p className="details-caption">Started {new Date(operation.started).toLocaleString()}{operation.longRunning ? ' · Pending for over 10 minutes' : ''}</p>}</DetailsSection>}
    <DetailsSection title={`Release events (${relatedEvents.length})`}>
      <p className="details-caption">Events for observed release objects, hooks and their loaded descendants. Unloaded objects and expired events may leave gaps.</p>
      <Button size="sm" disabled={activity.loading} onClick={() => { if (watchCoversEvents) void refreshResourceWatches('Event'); else activity.refresh(); }}>Refresh release events</Button>
      {activity.loading && <ResourceLoading compact label="Loading release events…" />}
      {activity.error && <RequestErrorNotice error={activity.error} onRetry={activity.refresh} retainedData={!!activity.data} />}
      {activity.data?.errors.map(({ namespace, error }) => <div key={namespace}><p className="details-caption">Events unavailable in {namespace}.</p><RequestErrorNotice error={error} onRetry={activity.refresh} /></div>)}
      {!activity.loading && !relatedEvents.length && <p className="details-caption">No matching events observed.</p>}
      {relatedEvents.slice(0, 100).map(event => <div key={event.event.uid} className="helm-hook"><button className="details-resource-row" onClick={() => onNavigate(event.item)}><ResourceKindBadge kind={event.item.kind} apiVersion={event.item.apiVersion} /><span>{event.item.name}</span><span className={event.warning ? 'text-[var(--status-warn)]' : 'details-caption'}>{event.reason}</span></button><p className="details-caption whitespace-pre-wrap break-words">{event.message}</p><p className="details-caption">{event.timestamp ? new Date(event.time).toLocaleString() : 'Time unavailable'} · {event.count} occurrence(s)</p></div>)}
      {relatedEvents.length > 100 && <p className="details-caption">First 100 events shown.</p>}
    </DetailsSection>
    {!active ? <DetailsSection title="Rendered objects & hooks"><p className="details-caption mb-2">Load the revision manifest and hooks on demand to compare rendered templates against loaded cluster resources.</p><Button size="sm" onClick={() => setRequested(true)}>Check rendered objects & hooks</Button></DetailsSection> : <>
      {result.loading && !result.data && <ResourceLoading label="Checking rendered objects and hooks…" />}
      {result.error && <RequestErrorNotice error={result.error} onRetry={result.refresh} retainedData={!!result.data} />}
      {result.data?.manifestError && <RequestErrorNotice error={result.data.manifestError} onRetry={result.refresh} />}
      {!!health.length && <DetailsSection title={`Rendered objects (${health.length})`}><p className="details-caption">Live status from the loaded scope. Unloaded objects have not been checked.</p>{health.slice(0, 50).map(row => <button key={`${row.reference.apiVersion}/${row.reference.kind}/${row.reference.namespace}/${row.reference.name}`} className="details-resource-row helm-evidence-row" disabled={!row.item} onClick={() => row.item && onNavigate(row.item)}><ResourceKindBadge kind={row.reference.kind} apiVersion={row.reference.apiVersion} /><span>{row.reference.name}</span><span className={row.issues.length ? 'text-[var(--status-warn)]' : 'details-caption'}>{row.label}</span></button>)}{health.length > 50 && <p className="details-caption">First 50 shown. The complete manifest is available in Manifest.</p>}</DetailsSection>}
      <DetailsSection title={`Hooks${result.data ? ` (${hooks.length})` : ''}`}>
        {result.data?.hookError && <RequestErrorNotice error={result.data.hookError} onRetry={result.refresh} />}
        {!hooks.length && result.data && !result.data.hookError && <p className="details-caption">No hooks in this revision.</p>}
        {hooks.slice(0, 50).map(row => <div key={`${row.reference.kind}/${row.reference.name}`} className="helm-hook"><button className="details-resource-row helm-evidence-row" disabled={!row.item} onClick={() => row.item && onNavigate(row.item)}><ResourceKindBadge kind={row.reference.kind} /><span>{row.reference.name}</span><span className={row.issues.length ? 'text-[var(--status-warn)]' : 'details-caption'}>{row.item ? row.label : 'No live object loaded'}</span></button><p className="details-caption">{row.reference.raw?.metadata?.annotations?.['helm.sh/hook'] ?? 'Hook'} · weight {row.reference.raw?.metadata?.annotations?.['helm.sh/hook-weight'] ?? '0'} · {row.reference.raw?.metadata?.annotations?.['helm.sh/hook-delete-policy'] ?? 'before-hook-creation'}</p>{!row.item && <p className="details-caption">The hook may have been cleaned up, or its namespace is outside the loaded scope.</p>}{row.item && (hookEventsByUid.get(row.item.uid) ?? []).slice(0, 3).map(event => <p key={event.event.uid} className="details-caption">{event.reason}: {event.message}</p>)}</div>)}
      </DetailsSection>
    </>}
  </>;
}
