import { CATEGORY_ICONS } from '../core/resource_icons';
import { useMemo, useState } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, RefreshCw, Search, X } from 'lucide-react';
import { useGitOpsDashboard } from '../providers/use_gitops_dashboard';
import { k8s } from '../providers/k8s_provider';
import { deliveryDescription, deliveryLabels, deliveryRevision, deliverySource, deliveryState, type DeliveryState } from '../core/resources/delivery';
import { namespaceScopeLabel } from '../core/resources/namespace_scope';
import { useResourceStore } from '../state/resource_store';
import { useClusterStore } from '../state/cluster_store';
import { useWorkspaceStore } from '../state/workspace_store';
import { useUiStore } from '../state/ui_store';
import { Button, IconButton } from '../components/ui/Button';
import { DeliverySummary, deliveryIcons, type DeliveryMetric } from '../components/ui/DeliverySummary';
import { RequestErrorNotice } from '../components/k8s/RequestErrorNotice';
import { ResourceLoading } from '../components/ui/ResourceLoading';
import { ResourceKindBadge } from '../components/k8s/ResourceKindBadge';
import type { ResourceItem } from '../types/k8s';
import './delivery.css';

const stateOrder: DeliveryState[] = ['attention', 'progressing', 'suspended', 'unknown', 'healthy'];
export function GitOpsDashboard({ family }: { family: 'flux' | 'argocd' }) {
  const result = useGitOpsDashboard(family);
  // Reset filters as well as data when switching clusters or namespace scopes.
  return <Dashboard key={JSON.stringify([family, result.context, result.scope])} family={family} result={result} />;
}

function Dashboard({ family, result }: { family: 'flux' | 'argocd'; result: ReturnType<typeof useGitOpsDashboard> }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [kind, setKind] = useState('all');
  const [order, setOrder] = useState('attention');
  const [page, setPage] = useState(0);
  const clusterLoading = useClusterStore(state => state.isLoading);
  const crdError = useResourceStore(state => state.loadErrors.CustomResourceDefinition);
  const selected = useResourceStore(state => state.selectedItem);
  const name = family === 'flux' ? 'Flux' : 'Argo CD';
  const Icon = CATEGORY_ICONS[family];
  const items = useMemo(() => result.entries.flatMap(entry => entry.items ?? []), [result.entries]);
  const primary = useMemo(() => family === 'argocd' ? items.filter(item => item.kind === 'Application') : items, [items, family]);
  const errors = result.entries.filter(entry => entry.error);
  const available = result.entries.some(entry => entry.items !== undefined);
  const metricsAvailable = family === 'argocd' ? result.entries.some(entry => entry.type.kind === 'Application' && entry.items !== undefined) : available;
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return items.filter(item => (kind === 'all' ? family !== 'argocd' || item.kind === 'Application' : item.kind === kind) && (filter === 'all' || deliveryState(item) === filter) && (!search || [item.name, item.namespace, item.kind, item.raw?.spec?.project, deliverySource(item), deliveryRevision(item)].some(value => value?.toLowerCase().includes(search))))
      .sort((a, b) => (order === 'attention' ? stateOrder.indexOf(deliveryState(a)) - stateOrder.indexOf(deliveryState(b)) : 0) || a.name.localeCompare(b.name) || (a.namespace ?? '').localeCompare(b.namespace ?? ''));
  }, [items, query, filter, kind, order, family]);
  const metrics: DeliveryMetric[] = [{ id: 'all', label: family === 'flux' ? 'Resources' : 'Applications', value: metricsAvailable ? primary.length : null, detail: errors.length ? 'Loaded snapshot · partial or stale' : 'In the selected scope' },
    ...(['healthy', 'attention', family === 'flux' ? 'suspended' : 'progressing', 'unknown'] as DeliveryState[]).map(state => ({ id: state, label: deliveryLabels[state], value: metricsAvailable ? primary.filter(item => deliveryState(item) === state).length : null, detail: state === 'healthy' ? family === 'flux' ? 'Readiness confirmed' : 'Healthy and synced' : state === 'attention' ? family === 'flux' ? 'Reconciliation needs review' : 'Health or sync needs review' : state === 'unknown' ? 'No confirmed readiness' : state === 'suspended' ? 'Reconciliation paused' : 'Delivery is running', tone: state === 'healthy' ? 'ok' as const : state === 'attention' ? 'warn' as const : 'muted' as const, icon: deliveryIcons[state] }))];
  const inspect = (item: ResourceItem) => { useResourceStore.getState().selectItem(item); useUiStore.setState({ inspectorCollapsed: false }); };
  const reset = () => { setQuery(''); setFilter('all'); setKind('all'); };
  const pageKey = JSON.stringify([query, filter, kind, order]);
  const [previousPageKey, setPreviousPageKey] = useState(pageKey);
  if (previousPageKey !== pageKey) { setPreviousPageKey(pageKey); setPage(0); }
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 50) - 1));
  if (!result.context) return <p className="p-6 text-[var(--text-secondary)]">Select a cluster to view {name}.</p>;
  return <section data-testid={`${family}-dashboard`} aria-label={`${name} overview`} aria-busy={result.loading} className="delivery-page kubiki-scrollbar">
    <header className="delivery-header"><div className="delivery-heading"><Icon size={22} aria-hidden="true" /><div><h1>{name} overview</h1><p>{result.context} · {namespaceScopeLabel(result.scope)}</p></div></div><IconButton icon={RefreshCw} aria-label={`Refresh ${name} overview`} tooltip="Refresh snapshot" disabled={result.loading} onClick={result.refresh} /></header>
    <div className="delivery-snapshot"><span>{result.loading ? 'Refreshing snapshot…' : result.updated ? `Snapshot · ${new Date(result.updated).toLocaleTimeString()}` : 'Awaiting resource discovery'}</span><span>{family === 'flux' ? 'Sources, delivery and automation' : 'Application health and sync'}{k8s.demo ? ' · Demo data' : ''}</span></div>
    {crdError && <RequestErrorNotice error={crdError} />}
    {!!errors.length && <details className="delivery-notice" open><summary>Partial or stale snapshot · {errors.length} resource type{errors.length === 1 ? '' : 's'} unavailable</summary>{errors.map(entry => <div key={entry.type.key}><strong>{entry.type.kind}</strong><RequestErrorNotice error={entry.error!} retainedData={entry.items !== undefined} onRetry={result.refresh} /></div>)}</details>}
    <DeliverySummary metrics={metrics} active={kind === 'all' ? filter : ''} onSelect={id => { setKind('all'); setFilter(id); }} />
    {family === 'argocd' && <div className="delivery-related">{['ApplicationSet', 'AppProject'].map(type => {
      const definition = result.definitions.find(entry => entry.kind === type);
      const entry = result.entries.find(entry => entry.type.kind === type);
      return <button key={type} disabled={!definition} onClick={() => { setKind(type); setFilter('all'); }} aria-pressed={kind === type}><span>{type === 'ApplicationSet' ? 'Application sets' : 'Projects'}</span><strong>{entry?.items?.length ?? '—'}</strong><ArrowRight size={12} aria-hidden="true" /></button>;
    })}</div>}
    <section className="delivery-inventory" aria-label={`${name} resource inventory`}>
      <div className="delivery-section-heading"><h2>{kind === 'all' ? family === 'flux' ? 'Resource inventory' : 'Applications' : kind}</h2><span>{filtered.length} shown</span></div>
      <div className="delivery-filters"><label className="delivery-search"><Search size={14} aria-hidden="true" /><input value={query} onChange={event => setQuery(event.target.value)} aria-label={`Search ${name} resources`} placeholder="Search name, namespace, source…" /></label>
        <label><span className="sr-only">Resource type</span><select className="ide-select" aria-label="Resource type" value={kind} onChange={event => setKind(event.target.value)}><option value="all">{family === 'flux' ? 'All resource types' : 'Applications'}</option>{result.definitions.filter(type => family === 'flux' || type.kind !== 'Application').map(type => <option key={type.key} value={type.kind}>{type.kind}</option>)}</select></label>
        <label><span className="sr-only">Delivery status</span><select className="ide-select" aria-label="Delivery status" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All statuses</option>{stateOrder.map(state => <option key={state} value={state}>{deliveryLabels[state]}</option>)}</select></label>
        <label><span className="sr-only">Sort resources</span><select className="ide-select" aria-label="Sort resources" value={order} onChange={event => setOrder(event.target.value)}><option value="attention">Attention first</option><option value="name">Name A–Z</option></select></label>
        {(query || filter !== 'all' || kind !== 'all') && <IconButton icon={X} aria-label="Clear dashboard filters" tooltip="Clear filters" onClick={reset} />}
      </div>
      {result.loading && !available ? <ResourceLoading label={`Loading ${name} resources…`} /> : !result.definitions.length ? <div className="delivery-empty"><Icon size={28} aria-hidden="true" /><h3>{clusterLoading ? 'Discovering resource types…' : `No ${name} resource types discovered`}</h3><p>{clusterLoading ? 'Waiting for the cluster resource catalog.' : 'Check that its CRDs are installed and you have permission to list them.'}</p></div>
        : !available && errors.length ? <div className="delivery-empty"><h3>Resource data unavailable</h3><p>Review the errors above and retry the snapshot.</p></div>
        : !filtered.length ? <div className="delivery-empty"><Search size={24} aria-hidden="true" /><h3>{items.length ? 'No resources match these filters' : `No ${name} resources in this scope`}</h3><p>{items.length ? 'Try another name, status or resource type.' : 'Choose another namespace or refresh the snapshot.'}</p>{items.length > 0 && <Button size="sm" onClick={reset}>Clear filters</Button>}</div>
        : <div className="delivery-table-scroll kubiki-scrollbar"><table className="delivery-table"><colgroup><col className="delivery-col-name" /><col className="delivery-col-status" /><col /><col className="delivery-col-revision" /></colgroup><thead><tr><th scope="col">Resource / namespace</th><th scope="col">{family === 'flux' ? 'Reconciliation' : 'Health / sync'}</th><th scope="col">{family === 'flux' ? 'Source' : 'Project / destination'}</th><th scope="col">Revision</th></tr></thead><tbody>{filtered.slice(currentPage * 50, (currentPage + 1) * 50).map(item => {
          const state = deliveryState(item); const StateIcon = deliveryIcons[state];
          return <tr key={`${item.apiVersion}/${item.uid}`} aria-selected={selected?.uid === item.uid && selected.apiVersion === item.apiVersion}>
            <td><button className="delivery-resource-link" onClick={() => inspect(item)} aria-label={`Inspect ${item.kind} ${item.name} in ${item.namespace ?? 'cluster'}`}><span className="truncate font-mono">{item.name}</span><ArrowRight size={12} aria-hidden="true" /></button><div className="delivery-resource-meta"><ResourceKindBadge kind={item.kind} apiVersion={item.apiVersion} /><span className="truncate">{item.namespace ?? 'Cluster scoped'}</span></div></td>
            <td><span className="delivery-status" data-state={state}><StateIcon size={13} aria-hidden="true" /><span className="truncate">{deliveryLabels[state]}</span></span><span className="delivery-secondary truncate">{deliveryDescription(item)}</span></td>
            <td>{family === 'flux' ? <span className="delivery-source truncate">{deliverySource(item)}</span> : <><span className="delivery-source truncate">{item.raw?.spec?.project ?? '—'}</span><span className="delivery-secondary truncate">{item.raw?.spec?.destination?.namespace ?? item.raw?.spec?.description ?? '—'}</span></>}</td>
            <td><span className="delivery-revision truncate">{deliveryRevision(item)}</span><button className="delivery-kind-link" onClick={() => { const definition = result.definitions.find(type => type.kind === item.kind && item.apiVersion.startsWith(`${type.group}/`)); if (definition) useWorkspaceStore.getState().openResourceList(definition.key); }}>Open list <ArrowRight size={11} aria-hidden="true" /></button></td>
          </tr>;
        })}</tbody></table></div>}
      {filtered.length > 50 && <nav className="delivery-pagination" aria-label="Dashboard pages"><span>{currentPage * 50 + 1}–{Math.min((currentPage + 1) * 50, filtered.length)} of {filtered.length}</span><IconButton icon={ChevronLeft} aria-label="Previous dashboard page" tooltip="Previous page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} /><IconButton icon={ChevronRight} aria-label="Next dashboard page" tooltip="Next page" disabled={(currentPage + 1) * 50 >= filtered.length} onClick={() => setPage(currentPage + 1)} /></nav>}
    </section>
  </section>;
}
