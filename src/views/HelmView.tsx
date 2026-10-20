import { useEffect, useMemo, useRef, useState } from 'react';
import { Anchor, Copy, RefreshCw, Search, X, GitBranch } from 'lucide-react';
import { useClusterStore } from '../state/cluster_store';
import { k8s } from '../providers/k8s_provider';
import { normalizeK8sError, type K8sRequestError } from '../providers/errors';
import { helmStatusTone, helmUpdatedAt, type HelmDocument, type HelmHistory, type HelmRelease, type HelmSection } from '../providers/helm_types';
import { Button } from '../components/ui/Button';
import { RequestErrorNotice } from '../components/k8s/RequestErrorNotice';
import { toast } from '../state/notifications_store';
import { HelmActionDialog, type HelmAction } from '../components/dialogs/HelmActionDialog';
import { FixedMenu, type MenuItem } from '../components/ui/Dropdown';
import { useResourceStore } from '../state/resource_store';
import { useWorkspaceStore } from '../state/workspace_store';
import { helmResource } from '../core/resources/helm';
import type { ResourceItem } from '../types/k8s';
import './helm.css';

/** Each response belongs to one scope. Old results can never replace another target. */
function useHelmRead<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>) {
  const reader = useRef(load); reader.current = load;
  const [epoch, retry] = useState(0);
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

export function HelmView({ section }: { section: HelmSection }) {
  const context = useClusterStore(state => state.currentContext);
  const scope = useClusterStore(state => state.selectedNamespace);
  if (section === 'repositories') return <HelmRepositories />;
  if (!context) return <div className="p-6 text-[var(--text-secondary)]">Select a cluster to view Helm releases.</div>;
  const namespace = scope === 'all' ? null : scope;
  return <HelmReleases key={JSON.stringify([context, namespace])} context={context} namespace={namespace} />;
}

function HelmReleases({ context, namespace }: { context: string; namespace: string | null }) {
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [order, setOrder] = useState('name');
  const [selected, select] = useState<HelmRelease | null>(null);
  const [action, setAction] = useState<{ action: HelmAction; release?: HelmRelease } | null>(null);
  const [menu, setMenu] = useState<{ release: HelmRelease; x: number; y: number } | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const result = useHelmRead(JSON.stringify([context, namespace, offset]), signal => k8s.getHelmReleases(context, namespace, offset, signal));
  const items = result.data?.items ?? [];
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    const rows = items.filter(item => (!search || item.name.toLowerCase().includes(search) || item.namespace.toLowerCase().includes(search)) && (status === 'all' || (status === 'problems' ? item.status === 'failed' || item.status.startsWith('pending-') || item.status === 'uninstalling' : item.status === status)));
    const rank = (item: HelmRelease) => item.status === 'failed' ? 0 : item.status.startsWith('pending-') || item.status === 'uninstalling' ? 1 : 2;
    return rows.sort((a, b) => (order === 'problems' ? rank(a) - rank(b) : order === 'newest' ? helmUpdatedAt(b.updated) - helmUpdatedAt(a.updated) : 0) || a.name.localeCompare(b.name) || a.namespace.localeCompare(b.namespace));
  }, [items, query, status, order]);
  // A changed release revision replaces the detail panel; a removed release closes it.
  const current = selected && (items.find(item => item.name === selected.name && item.namespace === selected.namespace) ?? null);
  const changePage = (next: number) => { select(null); setOffset(next); };
  return <section aria-label="Helm releases" data-testid="helm-releases" className="helm-workspace">
    <div className="helm-toolbar">
      <h1 className="flex items-center gap-2 font-medium shrink-0"><Anchor size={17} aria-hidden="true" />Helm Releases</h1><Button size="sm" disabled={!k8s.supportsHelmMutations} onClick={() => setAction({ action: 'install' })}>Install release</Button>
      <label className="helm-search"><Search size={14} aria-hidden="true" /><input aria-label="Search Helm releases by name or namespace" placeholder="Search name or namespace…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <select aria-label="Helm release status" className={field} value={status} onChange={event => setStatus(event.target.value)}><option value="all">All statuses</option><option value="problems">Problems</option><option value="deployed">Deployed</option><option value="failed">Failed</option><option value="uninstalled">Uninstalled</option><option value="superseded">Superseded</option></select>
      <select aria-label="Helm release order" className={field} value={order} onChange={event => setOrder(event.target.value)}><option value="name">Name A–Z</option><option value="problems">Problems first</option><option value="newest">Recently updated</option></select>
      <Button size="sm" disabled={result.loading} onClick={result.refresh} aria-label="Refresh Helm releases"><RefreshCw size={14} aria-hidden="true" />Refresh</Button>
    </div>
    <p className="helm-scope">{k8s.demo ? 'Demo · ' : ''}{context} · {namespace ?? 'All namespaces'} · {k8s.supportsHelmMutations ? 'Backend-confirmed changes' : 'Read only'}</p>
    {result.error && <RequestErrorNotice error={result.error} onRetry={result.refresh} retainedData={!!result.data} />}
    <div className={`helm-content${current ? ' has-detail' : ''}`}>
      <div className="helm-list">
        {result.loading && <p role="status" className="p-4 text-[var(--text-secondary)]">Loading releases…</p>}
        {!result.loading && result.data && !items.length && <p role="status" className="p-6 text-[var(--text-secondary)]">No Helm releases in this scope. Select another namespace or refresh the list.</p>}
        {!!items.length && <div className="helm-table-scroll kubiki-scrollbar"><table className="helm-table" aria-label="Helm release list"><thead><tr><th>Name</th><th>Namespace</th><th>Status</th><th>Chart</th><th>Revision</th><th>Updated</th></tr></thead><tbody>{filtered.map(release => <tr key={releaseKey(release)} ref={node => { if (node) rowRefs.current.set(releaseKey(release), node); else rowRefs.current.delete(releaseKey(release)); }} tabIndex={0} onContextMenu={event => { event.preventDefault(); setMenu({ release, x: event.clientX, y: event.clientY }); }} aria-label={`Inspect Helm release ${release.name} in ${release.namespace}`} aria-selected={current?.name === release.name && current.namespace === release.namespace} onClick={() => select(release)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(release); } }}><td className="font-mono" title={release.name}>{release.name}</td><td title={release.namespace}>{release.namespace}</td><td><Status status={release.status} /></td><td title={release.chart}>{release.chart}</td><td className="font-mono">{release.revision}</td><td className="text-[var(--text-secondary)]" title={release.updated}>{release.updated}</td></tr>)}</tbody></table>{!filtered.length && <p role="status" className="p-6 text-[var(--text-secondary)]">No releases match the filters on this page.</p>}</div>}
        {result.data && <div className="helm-pagination"><span>{filtered.length} of {items.length} on this page{offset > 0 ? ` · offset ${offset}` : ''}. Filters apply to this page.</span><div className="flex gap-2"><Button size="sm" disabled={offset === 0 || result.loading} onClick={() => changePage(Math.max(0, offset - result.data!.limit))}>Previous page</Button><Button size="sm" disabled={!result.data.has_more || result.loading} onClick={() => changePage(offset + result.data!.limit)}>Next page</Button></div></div>}
      </div>
      {current && <HelmReleaseDetails key={JSON.stringify([context, releaseKey(current)])} context={context} release={current} onChanged={result.refresh} onClose={() => { select(null); rowRefs.current.get(releaseKey(current))?.focus(); }} />}
    </div>
    {menu && <FixedMenu rect={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} items={([
      { id: 'inspect', label: 'Inspect release', onSelect: () => select(menu.release) },
      { id: 'topology', label: 'Open Helm topology', onSelect: () => openHelmTopology(context, menu.release) },
      ...(['upgrade', 'rollback', 'uninstall'] as const).map(operation => ({ id: operation, label: operation === 'rollback' ? 'Roll back…' : operation === 'uninstall' ? 'Uninstall…' : 'Upgrade…', danger: operation === 'uninstall', disabled: !k8s.supportsHelmMutations, onSelect: () => setAction({ action: operation, release: menu.release }) })),
    ] satisfies MenuItem[])} />}
    {action && <HelmActionDialog action={action.action} release={action.release} onClose={() => setAction(null)} onCompleted={result.refresh} />}
  </section>;
}

function Status({ status }: { status: string }) {
  return <span className={`inline-flex items-center gap-1.5 ${helmStatusTone(status)}`}><span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" aria-hidden="true" />{status}</span>;
}

function HelmReleaseDetails({ context, release, onClose, onChanged = () => {} }: { context: string; release: HelmRelease; onClose: () => void; onChanged?: () => void }) {
  const [action, setAction] = useState<HelmAction | null>(null);
  const resources = useResourceStore(state => state.resources);
  const managed = useMemo(() => Object.values(resources).flatMap(map => [...map.values()]).filter(item => { const metadata = item.raw?.metadata ?? item.metadata ?? {}; const annotations = metadata.annotations ?? {}; return metadata.labels?.['app.kubernetes.io/managed-by'] === 'Helm' && annotations['meta.helm.sh/release-name'] === release.name && annotations['meta.helm.sh/release-namespace'] === release.namespace; }), [resources, release.name, release.namespace]);
  const [tab, setTab] = useState<'overview' | 'history' | HelmDocument>('overview');
  const [revision, setRevision] = useState(Number(release.revision));
  const valuesRef = useRef<HTMLButtonElement>(null);
  const chooseRevision = (revision: number) => { setRevision(revision); setTab('values'); valuesRef.current?.focus(); };
  const tabs = ['overview', 'history', 'values', 'manifest', 'notes'] as const;
  return <aside aria-label={`Helm release details ${release.name}`} className="helm-details" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <div className="flex items-start gap-2 p-3 border-b border-[var(--border-default)] shrink-0"><div className="min-w-0 flex-1"><h2 className="font-mono font-medium break-all">{release.name}</h2><p className="text-xs text-[var(--text-secondary)] break-all mt-1">{context} · {release.namespace}</p></div><Button size="sm" aria-label="Close Helm details" onClick={onClose}><X size={14} /></Button></div>
    <div className="flex flex-wrap gap-2 px-3 py-2 border-b border-[var(--border-default)]"><Button size="sm" onClick={() => openHelmTopology(context, release)}><GitBranch size={13} aria-hidden="true" />Topology</Button>{(['upgrade', 'rollback', 'uninstall'] as const).map(operation => <Button key={operation} size="sm" disabled={!k8s.supportsHelmMutations} onClick={() => setAction(operation)}>{operation === 'rollback' ? 'Roll back' : operation === 'uninstall' ? 'Uninstall' : 'Upgrade'}</Button>)}</div>
    <div className="helm-detail-tabs" role="group" aria-label="Helm detail sections">{tabs.map(name => <button key={name} ref={name === 'values' ? valuesRef : undefined} aria-pressed={tab === name} onClick={() => setTab(name)} className={tab === name ? 'active' : ''}>{name.charAt(0).toUpperCase() + name.slice(1)}</button>)}</div>
    <div className="helm-detail-body kubiki-scrollbar">
      {tab === 'overview' ? <div className="p-4"><h3 className="text-xs font-medium text-[var(--text-secondary)] mb-3">Latest release snapshot</h3><dl className="helm-metadata">{[['Status', <Status key="status" status={release.status} />], ['Chart', release.chart], ['App version', release.app_version || '—'], ['Revision', release.revision], ['Updated', release.updated], ['Namespace', release.namespace]].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p className="text-xs text-[var(--text-secondary)] mt-5 leading-relaxed">Values shows the user-supplied overrides for a revision. Manifest shows the rendered Kubernetes objects. Choose a history row to inspect an earlier revision.</p><h3 className="font-medium mt-4 mb-2">Managed Kubernetes objects ({managed.length} loaded)</h3><p className="text-xs text-[var(--text-secondary)] mb-2">Matches exact Helm ownership annotations in the loaded resource snapshots.</p><div className="space-y-1">{managed.slice(0, 50).map(item => <button key={item.uid} className="w-full text-left rounded p-2 hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)]" onClick={() => useWorkspaceStore.getState().openResourceDetail(item)}>{item.kind} · {item.namespace || 'cluster'} · {item.name}</button>)}</div>{managed.length > 50 && <p className="text-xs mt-2">First 50 objects shown. Open the topology for relationships.</p>}</div>
      : tab === 'history' ? <HelmHistoryPane context={context} release={release} onSelect={chooseRevision} />
      : <HelmDocumentPane key={`${revision}/${tab}`} context={context} release={release} revision={revision} document={tab} onLatest={() => setRevision(Number(release.revision))} />}
    </div>
    {action && <HelmActionDialog action={action} release={release} onClose={() => setAction(null)} onCompleted={onChanged} />}
  </aside>;
}

function HelmHistoryPane({ context, release, onSelect }: { context: string; release: HelmRelease; onSelect: (revision: number) => void }) {
  const result = useHelmRead(JSON.stringify([context, release.namespace, release.name, 'history']), signal => k8s.getHelmHistory(context, release.namespace, release.name, signal));
  const rows = [...(result.data ?? [])].sort((a, b) => b.revision - a.revision);
  return <div>{result.loading && <p role="status" className="p-4">Loading history…</p>}{result.error && <RequestErrorNotice error={result.error} onRetry={result.refresh} retainedData={!!result.data} />}{result.data && <><p className="p-3 text-xs text-[var(--text-secondary)]">Up to 256 revisions. Select a revision to inspect its values.</p><div className="overflow-auto kubiki-scrollbar"><table className="helm-table" aria-label="Helm release history"><thead><tr><th>Revision</th><th>Status</th><th>Chart</th><th>Description</th><th>Updated</th></tr></thead><tbody>{rows.map((row: HelmHistory) => <tr key={row.revision} tabIndex={0} aria-label={`Inspect Helm revision ${row.revision}`} onClick={() => onSelect(row.revision)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(row.revision); } }}><td>{row.revision}</td><td><Status status={row.status} /></td><td>{row.chart}</td><td title={row.description}>{row.description}</td><td title={row.updated}>{row.updated}</td></tr>)}</tbody></table>{!rows.length && <p className="p-4">No revision history available.</p>}</div></>}</div>;
}

function HelmDocumentPane({ context, release, revision, document, onLatest }: { context: string; release: HelmRelease; revision: number; document: HelmDocument; onLatest: () => void }) {
  const result = useHelmRead(JSON.stringify([context, releaseKey(release), revision, document]), signal => k8s.getHelmContent(context, release.namespace, release.name, revision, document, signal));
  return <div className="p-3 min-w-0"><div className="flex flex-wrap items-center gap-2 mb-3"><span className="text-xs text-[var(--text-secondary)] flex-1">{document} · revision {revision}</span>{revision !== Number(release.revision) && <Button size="sm" onClick={onLatest}>Latest revision</Button>}{result.data !== null && <Button size="sm" aria-label={`Copy Helm ${document}`} onClick={() => { void navigator.clipboard.writeText(result.data!).then(() => toast.success('Copied')).catch(() => toast.error('Clipboard unavailable')); }}><Copy size={13} aria-hidden="true" />Copy</Button>}</div>{result.loading && <p role="status">Loading {document}…</p>}{result.error && <RequestErrorNotice error={result.error} onRetry={result.refresh} retainedData={result.data !== null} />}{result.data !== null && <pre tabIndex={0} aria-label={`Helm ${document} revision ${revision}`} className="helm-document kubiki-scrollbar">{result.data.trim() ? result.data : `No ${document} for this revision.`}</pre>}</div>;
}

function HelmRepositories() {
  const [action, setAction] = useState<{ action: HelmAction; repo?: import('../providers/helm_types').HelmRepo } | null>(null);
  const [menu, setMenu] = useState<{ repo: import('../providers/helm_types').HelmRepo; x: number; y: number } | null>(null);
  const [query, setQuery] = useState('');
  const result = useHelmRead('helm-repositories', signal => k8s.getHelmRepositories(signal));
  const rows = result.data?.filter(repo => repo.name.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  const displayUrl = (url: string) => { try { const value = new URL(url); if (value.username || value.password) { value.username = 'redacted'; value.password = ''; } return value.toString(); } catch { return url; } };
  return <section aria-label="Helm repositories" data-testid="helm-repositories" className="helm-workspace"><div className="helm-toolbar"><h1 className="flex items-center gap-2 font-medium"><Anchor size={17} aria-hidden="true" />Helm Repositories</h1><Button size="sm" disabled={!k8s.supportsHelmMutations} onClick={() => setAction({ action: 'repository_set' })}>Add repository</Button><Button size="sm" disabled={!k8s.supportsHelmMutations} onClick={() => setAction({ action: 'repository_update' })}>Update indexes</Button><label className="helm-search"><Search size={14} aria-hidden="true" /><input aria-label="Search Helm repositories by name" placeholder="Search repository name…" value={query} onChange={event => setQuery(event.target.value)} /></label><Button size="sm" disabled={result.loading} onClick={result.refresh} aria-label="Refresh Helm repositories"><RefreshCw size={14} aria-hidden="true" />Refresh</Button></div><p className="helm-scope">{k8s.demo ? 'Demo · ' : ''}Local Helm configuration · Shared across clusters · {k8s.supportsHelmMutations ? 'Backend-confirmed changes' : 'Read only'}</p>{result.error && <RequestErrorNotice error={result.error} onRetry={result.refresh} retainedData={!!result.data} />}{result.loading && <p role="status" className="p-4">Loading repositories…</p>}{result.data && <div className="helm-table-scroll kubiki-scrollbar">{rows.length ? <table className="helm-table helm-repo-table" aria-label="Helm repository list"><thead><tr><th>Name</th><th>URL</th></tr></thead><tbody>{rows.map(repo => <tr key={repo.name} tabIndex={0} aria-label={`Helm repository ${repo.name}`} onContextMenu={event => { event.preventDefault(); setMenu({ repo, x: event.clientX, y: event.clientY }); }}><td className="font-mono">{repo.name}</td><td className="break-all">{displayUrl(repo.url)}</td></tr>)}</tbody></table> : <p role="status" className="p-6 text-[var(--text-secondary)]">{result.data.length ? 'No repositories match this name.' : 'No repositories configured in the local Helm CLI.'}</p>}</div>}{menu && <FixedMenu rect={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} items={([
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

export function HelmReleaseWorkspace({ item }: { item: ResourceItem }) {
  const context = useClusterStore(state => state.currentContext)!;
  const original = item.raw!.release as HelmRelease;
  const result = useHelmRead(JSON.stringify([context, item.namespace, item.name]), signal => k8s.getHelmHistory(context, item.namespace!, item.name, signal));
  const latest = result.data?.reduce((latest, row) => row.revision > latest.revision ? row : latest, result.data[0]);
  const release = latest ? { ...original, revision: String(latest.revision), updated: latest.updated, status: latest.status, chart: latest.chart, app_version: latest.app_version } : original;
  return <section className="helm-workspace"><div className="helm-toolbar"><h1 className="font-medium">Helm: {item.name}</h1><Button size="sm" disabled={result.loading} onClick={result.refresh}>Refresh release</Button></div>{result.error && <RequestErrorNotice error={result.error} onRetry={result.refresh} retainedData />}{result.loading && <p role="status" className="p-3">Loading release revision…</p>}<HelmReleaseDetails key={release.revision} context={context} release={release} onChanged={result.refresh} onClose={() => useWorkspaceStore.getState().closeTab(useWorkspaceStore.getState().activeTabId)} /></section>;
}
