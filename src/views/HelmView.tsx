import { namespaceScopeLabel } from '../core/resources/namespace_scope';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Anchor, Copy, RefreshCw, Search, GitBranch, ArrowUpCircle, RotateCcw, Trash2, MoreHorizontal, Package, Boxes, FileCode, SlidersHorizontal, Plus } from 'lucide-react';
import { useClusterStore } from '../state/cluster_store';
import { k8s } from '../providers/k8s_provider';
import { normalizeK8sError, type K8sRequestError } from '../providers/errors';
import { helmStatusTone, helmUpdatedAt, type HelmDocument, type HelmHistory, type HelmRelease, type HelmSection } from '../providers/helm_types';
import { Button, IconButton } from '../components/ui/Button';
import { DeliverySummary, deliveryIcons } from '../components/ui/DeliverySummary';
import { RequestErrorNotice } from '../components/k8s/RequestErrorNotice';
import { toast } from '../state/notifications_store';
import { HelmActionDialog, type HelmAction } from '../components/dialogs/HelmActionDialog';
import { FixedMenu, MenuList, Popover, type MenuItem } from '../components/ui/Dropdown';
import { useResourceStore } from '../state/resource_store';
import { useWorkspaceStore } from '../state/workspace_store';
import { helmResource } from '../core/resources/helm';
import type { ResourceItem } from '../types/k8s';
import { DetailsPanel } from '../components/k8s/details/DetailsPanel';
import { DetailsSection } from '../components/k8s/details/DetailsSection';
import { ResourceKindBadge } from '../components/k8s/ResourceKindBadge';
import { ResourceLoading } from '../components/ui/ResourceLoading';
import { Fragment } from 'react';
import type { ResourceDetailsProps } from '../components/layout/InspectorPanel';
import { cacheHelmReleases, inspectHelmRelease } from '../state/helm_resources';
import { subscribeHelmChanges } from '../providers/use_helm_graph';
import { useUiStore } from '../state/ui_store';
import { useHelmInventory } from '../providers/use_helm_inventory';
import { useFluxHelmOwners } from '../providers/use_flux_helm_owners';
import { fluxReleaseOwner, helmOperation, parseReleaseManifest, releaseHealth, releaseObjects } from '../core/resources/helm_diagnostics';
import { resourceIssues } from '../core/resources/diagnostics';
import { resourceEvents } from '../core/resources/resource_events';
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
const field = 'ide-select min-w-0 max-w-full';
const helmDocumentCache = new Map<string, string>();
subscribeHelmChanges(() => helmDocumentCache.clear());

async function readHelmDocument(context: string, namespace: string, name: string, revision: number, document: HelmDocument, signal: AbortSignal): Promise<string> {
  const key = JSON.stringify([context, namespace, name, revision, document]);
  const cached = helmDocumentCache.get(key);
  if (cached !== undefined) return cached;
  const content = await k8s.getHelmContent(context, namespace, name, revision, document, signal);
  helmDocumentCache.set(key, content);
  if (helmDocumentCache.size > 64) helmDocumentCache.delete(helmDocumentCache.keys().next().value!);
  return content;
}

export function HelmView({ section }: { section: HelmSection }) {
  const context = useClusterStore(state => state.currentContext);
  const scope = useClusterStore(state => state.selectedNamespace);
  if (section === 'repositories') return <HelmRepositories />;
  if (!context) return <div className="p-6 text-[var(--text-secondary)]">Select a cluster to view Helm releases.</div>;
  const namespace = scope === 'all' ? null : scope;
  return <HelmReleases key={JSON.stringify([context, namespace])} context={context} namespace={namespace} />;
}

function HelmReleases({ context, namespace }: { context: string; namespace: string | null }) {
  const [visibleCount, setVisibleCount] = useState(100);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [order, setOrder] = useState('name');
  const selected = useResourceStore(state => state.selectedItem);
  const [action, setAction] = useState<{ action: HelmAction; release?: HelmRelease } | null>(null);
  const [menu, setMenu] = useState<{ release: HelmRelease; x: number; y: number } | null>(null);
  const result = useHelmInventory(context, namespace);
  const owners = useFluxHelmOwners(context, null);
  const resources = useResourceStore(state => state.resources);
  const objectsByRelease = useMemo(() => {
    const map = new Map<string, ResourceItem[]>();
    for (const [kind, bucket] of Object.entries(resources)) {
      if (kind === 'Event' || kind === 'HelmRelease') continue;
      for (const item of bucket.values()) {
        const metadata = item.raw?.metadata ?? item.metadata ?? {};
        if (metadata.labels?.['app.kubernetes.io/managed-by'] !== 'Helm') continue;
        const releaseName = metadata.annotations?.['meta.helm.sh/release-name'];
        const releaseNamespace = metadata.annotations?.['meta.helm.sh/release-namespace'];
        if (!releaseName || !releaseNamespace) continue;
        const key = `${releaseNamespace}\0${releaseName}`;
        const list = map.get(key);
        if (list) list.push(item);
        else map.set(key, [item]);
      }
    }
    return map;
  }, [resources]);
  const items = result.data ?? [];
  useEffect(() => { if (result.data) cacheHelmReleases(context, result.data); }, [context, result.data]);
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    const rows = items.filter(item => (!search || item.name.toLowerCase().includes(search) || item.namespace.toLowerCase().includes(search)) && (status === 'all' || (status === 'progressing' ? item.status.startsWith('pending-') || item.status === 'uninstalling' : status === 'problems' ? item.status === 'failed' || item.status.startsWith('pending-') || item.status === 'uninstalling' : item.status === status)));
    const rank = (item: HelmRelease) => item.status === 'failed' ? 0 : item.status.startsWith('pending-') || item.status === 'uninstalling' ? 1 : 2;
    return rows.sort((a, b) => (order === 'problems' ? rank(a) - rank(b) : order === 'newest' ? helmUpdatedAt(b.updated) - helmUpdatedAt(a.updated) : 0) || a.name.localeCompare(b.name) || a.namespace.localeCompare(b.namespace));
  }, [items, query, status, order]);
  // Selection and revision updates share the ordinary resource inspector.
  const current = selected?.kind === 'HelmRelease' && selected.raw?.context === context ? selected : null;
  useEffect(() => { setVisibleCount(100); }, [query, status, order]);
  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && visible.length < filtered.length && el.scrollHeight <= el.clientHeight) {
      setVisibleCount(count => Math.min(filtered.length, count + 100));
    }
  }, [visible.length, filtered.length]);
  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (visibleCount >= filtered.length) return;
    const el = event.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 160) {
      setVisibleCount(count => Math.min(filtered.length, count + 100));
    }
  };
  return <section aria-label="Helm releases" data-testid="helm-releases" aria-busy={result.loading} className="helm-workspace">
    <div className="helm-toolbar">
      <h1><Anchor size={15} aria-hidden="true" />Helm Releases</h1>
      <Button size="sm" aria-label="Install release" title="Install release" disabled={!k8s.supportsHelmMutations} onClick={() => setAction({ action: 'install' })}><Plus size={13} aria-hidden="true" /><span className="helm-action-label">Install release</span></Button>
      <IconButton icon={RefreshCw} size="sm" disabled={result.loading} onClick={() => { result.refresh();owners.refresh(); }} aria-label="Refresh Helm releases" tooltip="Refresh releases" />
    </div>
    <div className="helm-dashboard-summary">
      <DeliverySummary active={status} onSelect={setStatus} metrics={[
        { id: 'all', label: 'Releases', value: result.data ? items.length : null, detail: 'Across the selected scope' },
        { id: 'deployed', label: 'Deployed', value: result.data ? items.filter(item => item.status === 'deployed').length : null, detail: 'Successfully deployed', tone: 'ok', icon: deliveryIcons.healthy },
        { id: 'failed', label: 'Failed', value: result.data ? items.filter(item => item.status === 'failed').length : null, detail: 'Last operation failed', tone: 'warn', icon: deliveryIcons.attention },
        { id: 'progressing', label: 'In progress', value: result.data ? items.filter(item => item.status.startsWith('pending-') || item.status === 'uninstalling').length : null, detail: 'Install, upgrade or uninstall', tone: 'muted', icon: deliveryIcons.progressing },
      ]} />
      <p className="helm-dashboard-caption">{namespaceScopeLabel(namespace ?? 'all')} · {result.error ? 'Last complete snapshot' : 'Complete release inventory'} · auto 30s</p>
    </div>
    <div className="helm-filterbar">
      <label className="helm-search"><Search size={13} aria-hidden="true" /><input aria-label="Search Helm releases by name or namespace" placeholder="Filter releases…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <Popover align="end" width={240} trigger={() => <Button size="sm" aria-label="Helm release filters" className="resource-filter-trigger"><SlidersHorizontal size={13} aria-hidden="true" />Filters<span className="helm-filter-count">{Number(status !== 'all') + Number(order !== 'name') || ''}</span></Button>}>
        {close => <div role="dialog" aria-label="Helm release filters" className="p-2 space-y-2">
          <label className="resource-filter-field"><span>Status</span><select aria-label="Helm release status" className={field} value={status} onChange={event => setStatus(event.target.value)}><option value="all">All statuses</option><option value="problems">Problems</option><option value="progressing">In progress</option><option value="deployed">Deployed</option><option value="failed">Failed</option><option value="uninstalled">Uninstalled</option><option value="superseded">Superseded</option></select></label>
          <label className="resource-filter-field"><span>Order</span><select aria-label="Helm release order" className={field} value={order} onChange={event => setOrder(event.target.value)}><option value="name">Name A–Z</option><option value="problems">Problems first</option><option value="newest">Recently updated</option></select></label>
          <Button size="sm" onClick={close}>Done</Button>
        </div>}
      </Popover>
    </div>
    <p className="helm-scope">{k8s.demo ? 'Demo · ' : ''}{context} · {namespaceScopeLabel(namespace ?? 'all')} · {k8s.supportsHelmMutations ? 'Backend-confirmed changes' : 'Read only'}</p>
    {result.error && <RequestErrorNotice error={result.error} onRetry={result.refresh} retainedData={!!result.data} />}
    {owners.error && <RequestErrorNotice error={owners.error} retainedData={!!owners.items.length} onRetry={owners.refresh} />}
    <div className="helm-content">
      <div className="helm-list">
        {result.loading && !result.data && <ResourceLoading label="Loading releases…" />}
        {!result.loading && result.data && !items.length && <p role="status" className="p-6 text-[var(--text-secondary)]">No Helm releases in this scope. Select another namespace or refresh the list.</p>}
        {!!items.length && <div ref={scrollRef} onScroll={handleScroll} className="helm-table-scroll kubiki-scrollbar"><table className="helm-table" aria-label="Helm release list"><thead><tr><th>Name</th><th>Namespace</th><th>Status</th><th>Chart</th><th>Observed health</th><th>Revision</th><th>Updated</th></tr></thead><tbody>{visible.map(release => <tr key={releaseKey(release)} tabIndex={0} onContextMenu={event => { event.preventDefault(); setMenu({ release, x: event.clientX, y: event.clientY }); }} aria-label={`Inspect Helm release ${release.name} in ${release.namespace}`} aria-selected={current?.name === release.name && current.namespace === release.namespace} onClick={() => inspectHelmRelease(context, release)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspectHelmRelease(context, release); } }}><td className="font-mono" title={release.name}>{release.name}{fluxReleaseOwner(release, owners.items) && <span className="helm-flux-label">Flux managed</span>}</td><td title={release.namespace}>{release.namespace}</td><td><Status status={release.status} /></td><td title={release.chart}>{release.chart}</td><td><ObservedHealth objects={objectsByRelease.get(`${release.namespace}\0${release.name}`) ?? EMPTY_OBJECTS} /></td><td className="font-mono">{release.revision}</td><td className="text-[var(--text-secondary)]" title={release.updated}>{release.updated}</td></tr>)}</tbody></table>{!filtered.length && <p role="status" className="p-6 text-[var(--text-secondary)]">No releases match these filters.</p>}</div>}
        {result.data && <div className="helm-pagination"><span>{filtered.length ? `1–${visible.length}` : '0'} of {filtered.length} matching · {items.length} total</span></div>}
      </div>
    </div>
    {menu && <FixedMenu rect={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} items={([
      { id: 'inspect', label: 'Inspect release', onSelect: () => inspectHelmRelease(context, menu.release) },
      { id: 'topology', label: 'Open Helm topology', onSelect: () => openHelmTopology(context, menu.release) },
      ...(['upgrade', 'rollback', 'uninstall'] as const).map(operation => ({ id: operation, label: operation === 'rollback' ? 'Roll back…' : operation === 'uninstall' ? 'Uninstall…' : 'Upgrade…', danger: operation === 'uninstall', disabled: !k8s.supportsHelmMutations || owners.loading || !!fluxReleaseOwner(menu.release, owners.items), onSelect: () => setAction({ action: operation, release: menu.release }) })),
    ] satisfies MenuItem[])} />}
    {action && <HelmActionDialog action={action.action} release={action.release} onClose={() => setAction(null)} onCompleted={() => {
      if (action.action === 'uninstall' && action.release) {
        const uid = helmResource(context, action.release).uid;
        const store = useResourceStore.getState();
        if (store.selectedItem?.uid === uid) useUiStore.setState({ inspectorCollapsed: true });
        store.deleteItem('HelmRelease', uid);
      }
      result.refresh();
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
  const navigate = (next: ResourceItem) => { setTab('overview'); onNavigate(next); };
  const owners = useFluxHelmOwners(context, null);
  const owner = fluxReleaseOwner({ name: item.name, namespace: item.namespace! }, owners.items);
  const canChange = !owner && !owners.loading && k8s.supportsHelmMutations && !!release && !history.loading && !history.error;
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
      else history.refresh();
    }} />}>
    <div className={`details-scroll kubiki-scrollbar helm-detail-content ${tab !== 'overview' && tab !== 'history' ? 'helm-document-scroll' : ''}`}>
      {history.error && tab !== 'history' && <RequestErrorNotice error={history.error} onRetry={history.refresh} retainedData={!!release} />}
      {history.loading && !release && tab !== 'history' && <ResourceLoading label="Loading release revision…" />}
      {!history.loading && !history.error && !release && tab !== 'history' && <p role="status" className="p-3 text-xs text-[var(--text-secondary)]">No release revision is available. Refresh or choose another release.</p>}
      {tab === 'history' ? <HelmHistoryPane result={history} release={release} onSelect={chooseRevision} canRestore={canChange} onRestore={revision => setAction({ kind: 'rollback', revision })} />
        : release && tab === 'overview' ? <div className="details-body details-stack">
          {owner && <DetailsSection title="Managed by Flux"><p className="details-caption">Change the Flux HelmRelease to keep the release in sync with its source.</p><button className="details-resource-row" onClick={() => navigate(owner)}>{owner.namespace}/{owner.name}</button></DetailsSection>}
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
      <table className="helm-table helm-history" aria-label="Helm release history">
        <thead><tr><th>Rev.</th><th>Status</th><th>Chart</th><th>Updated</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{rows.map((row: HelmHistory) => <tr key={row.revision}>
          <td className="font-mono">{row.revision}<span className="helm-history-current">{row.revision === Number(release?.revision) ? 'Current' : '\u00a0'}</span></td>
          <td><Status status={row.status} /></td>
          <td><span className="helm-history-chart" title={row.chart}>{row.chart}</span><span className="helm-history-status-compact"><Status status={row.status} /></span><span className="helm-history-description" title={row.description}>{row.description || '\u00a0'}</span></td>
          <td title={row.updated}>{row.updated}</td>
          <td><div className="helm-history-actions">
            <IconButton icon={FileCode} size="sm" aria-label={`Inspect Helm revision ${row.revision}`} tooltip={`Values for revision ${row.revision}`} onClick={() => onSelect(row.revision)} />
            <IconButton icon={RotateCcw} size="sm" disabled={!canRestore || row.revision === Number(release?.revision) || !k8s.supportsHelmMutations || !!result.error || result.loading} aria-label={`Restore Helm revision ${row.revision}`} tooltip={`Restore revision ${row.revision}`} onClick={() => onRestore(row.revision)} />
          </div></td>
        </tr>)}</tbody>
      </table>{!rows.length && <p className="details-empty">No revision history available.</p>}
    </DetailsSection>}
  </div>;
}

function HelmDocumentPane({ context, release, revision, document, onLatest }: { context: string; release: HelmRelease; revision: number; document: HelmDocument; onLatest: () => void }) {
  const result = useHelmRead(JSON.stringify([context, releaseKey(release), revision, document]), signal => readHelmDocument(context, release.namespace, release.name, revision, document, signal));
  return <div className="helm-document-pane" aria-busy={result.loading}>
    <div className="helm-document-toolbar">
      <span className="min-w-0 flex-1 truncate details-caption">{document} · revision {revision}</span>
      <IconButton icon={RotateCcw} size="sm" disabled={revision === Number(release.revision)} onClick={onLatest} aria-label="Latest revision" tooltip="Latest revision" />
      <IconButton icon={Copy} size="sm" disabled={result.data === null} aria-label={`Copy Helm ${document}`} tooltip={`Copy ${document}`} onClick={() => { void navigator.clipboard.writeText(result.data!).then(() => toast.success('Copied')).catch(() => toast.error('Clipboard unavailable')); }} />
    </div>
    {result.error && <RequestErrorNotice error={result.error} onRetry={result.refresh} retainedData={result.data !== null} />}
    {result.data === null ? <div role="status" className="details-loading">{result.loading ? <ResourceLoading label={`Loading ${document}…`} /> : `No ${document} available.`}</div>
      : <pre tabIndex={0} aria-label={`Helm ${document} revision ${revision}`} className="helm-document kubiki-scrollbar">{result.data.trim() ? result.data : `No ${document} for this revision.`}</pre>}
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
    </div><div className="helm-filterbar"><label className="helm-search"><Search size={13} aria-hidden="true" /><input aria-label="Search Helm repositories by name" placeholder="Filter repositories…" value={query} onChange={event => setQuery(event.target.value)} /></label></div><p className="helm-scope">{k8s.demo ? 'Demo · ' : ''}Local Helm configuration · Shared across clusters · {k8s.supportsHelmMutations ? 'Backend-confirmed changes' : 'Read only'}</p>{result.error && <RequestErrorNotice error={result.error} onRetry={result.refresh} retainedData={!!result.data} />}{result.loading && !result.data && <ResourceLoading label="Loading repositories…" />}{result.data && <div className="helm-table-scroll kubiki-scrollbar">{rows.length ? <table className="helm-table helm-repo-table" aria-label="Helm repository list"><thead><tr><th>Name</th><th>URL</th></tr></thead><tbody>{rows.map(repo => <tr key={repo.name} tabIndex={0} aria-label={`Helm repository ${repo.name}`} onContextMenu={event => { event.preventDefault(); setMenu({ repo, x: event.clientX, y: event.clientY }); }}><td className="font-mono">{repo.name}</td><td className="break-all">{displayUrl(repo.url)}</td></tr>)}</tbody></table> : <p role="status" className="p-6 text-[var(--text-secondary)]">{result.data.length ? 'No repositories match this name.' : 'No repositories configured in the local Helm CLI.'}</p>}</div>}{menu && <FixedMenu rect={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} items={([
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

const EMPTY_OBJECTS: ResourceItem[] = [];

function ObservedHealth({ objects }: { objects: ResourceItem[] }) {
  const issues = objects.filter(item => resourceIssues(item).length);
  return <span className={issues.length ? 'text-[var(--status-warn)]' : 'text-[var(--text-secondary)]'} title="Health of loaded objects with Helm ownership annotations; not a complete release check">{!objects.length ? 'Not loaded' : issues.length ? `${issues.length} with issues / ${objects.length} loaded` : `${objects.length} loaded · no issues`}</span>;
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
  return <>
    {(operation.pending || operation.failed) && <DetailsSection title={operation.label}><p className="details-caption">{operation.message}</p>{operation.started > 0 && <p className="details-caption">Started {new Date(operation.started).toLocaleString()}{operation.longRunning ? ' · Pending for over 10 minutes' : ''}</p>}</DetailsSection>}
    {!active ? <DetailsSection title="Rendered objects & hooks"><p className="details-caption mb-2">Load the revision manifest and hooks on demand to compare rendered templates against loaded cluster resources.</p><Button size="sm" onClick={() => setRequested(true)}>Check rendered objects & hooks</Button></DetailsSection> : <>
      {result.loading && !result.data && <ResourceLoading label="Checking rendered objects and hooks…" />}
      {result.error && <RequestErrorNotice error={result.error} onRetry={result.refresh} retainedData={!!result.data} />}
      {result.data?.manifestError && <RequestErrorNotice error={result.data.manifestError} onRetry={result.refresh} />}
      {!!health.length && <DetailsSection title={`Rendered objects (${health.length})`}><p className="details-caption">Live status from the loaded scope. Unloaded objects have not been checked.</p>{health.slice(0, 50).map(row => <button key={`${row.reference.apiVersion}/${row.reference.kind}/${row.reference.namespace}/${row.reference.name}`} className="details-resource-row helm-evidence-row" disabled={!row.item} onClick={() => row.item && onNavigate(row.item)}><ResourceKindBadge kind={row.reference.kind} apiVersion={row.reference.apiVersion} /><span>{row.reference.name}</span><span className={row.issues.length ? 'text-[var(--status-warn)]' : 'details-caption'}>{row.label}</span></button>)}{health.length > 50 && <p className="details-caption">First 50 shown. The complete manifest is available in Manifest.</p>}</DetailsSection>}
      <DetailsSection title={`Hooks${result.data ? ` (${hooks.length})` : ''}`}>
        {result.data?.hookError && <RequestErrorNotice error={result.data.hookError} onRetry={result.refresh} />}
        {!hooks.length && result.data && !result.data.hookError && <p className="details-caption">No hooks in this revision.</p>}
        {hooks.slice(0, 50).map(row => <div key={`${row.reference.kind}/${row.reference.name}`} className="helm-hook"><button className="details-resource-row helm-evidence-row" disabled={!row.item} onClick={() => row.item && onNavigate(row.item)}><ResourceKindBadge kind={row.reference.kind} /><span>{row.reference.name}</span><span className={row.issues.length ? 'text-[var(--status-warn)]' : 'details-caption'}>{row.item ? row.label : 'No live object loaded'}</span></button><p className="details-caption">{row.reference.raw?.metadata?.annotations?.['helm.sh/hook'] ?? 'Hook'} · weight {row.reference.raw?.metadata?.annotations?.['helm.sh/hook-weight'] ?? '0'} · {row.reference.raw?.metadata?.annotations?.['helm.sh/hook-delete-policy'] ?? 'before-hook-creation'}</p>{!row.item && <p className="details-caption">The hook may have been cleaned up, or its namespace is outside the loaded scope.</p>}{row.item && resourceEvents(events, row.item).slice(0, 3).map(event => <p key={event.event.uid} className="details-caption">{event.reason}: {event.message}</p>)}</div>)}
      </DetailsSection>
    </>}
  </>;
}
