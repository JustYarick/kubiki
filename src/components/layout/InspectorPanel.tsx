import { SecretDataEditor } from '../k8s/SecretDataEditor';
import React, { Suspense, lazy, useId, useMemo, useState, useEffect } from 'react';
import { Pin, ArrowLeft, ArrowRight, ArrowRightLeft, Boxes, Copy, FileText, GitBranch, Loader2, Terminal, X, ExternalLink } from 'lucide-react';
import { useResourceStore } from '../../state/resource_store';
import type { RightTab } from '../../state/ui_store';
import { useUiStore } from '../../state/ui_store';
import { useWorkspaceStore } from '../../state/workspace_store';
import { useDockStore } from '../../state/dock_store';
import { KIND_ICONS } from '../../core/perspectives';
import { buildResourceGraph } from '../../core/resources/relationships';
import { useHelmGraph } from '../../providers/use_helm_graph';
import { resourceKey } from '../../core/resources/identity';
import { resourceEvents } from '../../core/resources/resource_events';
import { ContainerStatusIcon } from '../k8s/ContainerSelect';
import { canExecContainer, podContainers, CONTAINER_ROLE_LABEL } from '../../core/resources/containers';
import { NamespaceScopeNotice } from '../k8s/NamespaceScopeNotice';
import { ResourceWarnings } from '../k8s/ResourceWarnings';
import { ResourceKindBadge } from '../k8s/ResourceKindBadge';
import { ResourceAnnotations } from '../k8s/ResourceAnnotations';
import { StatusBadge } from '../k8s/StatusBadge';
import { IconButton, Button } from '../ui/Button';
import { SearchInput } from '../ui/Input';
import { PFDialog } from '../dialogs/PFDialog';
import { toast } from '../../state/notifications_store';
import { parse } from 'yaml';
import { mapK8sResource } from '../../core/utils/k8s_mapper';
import { k8s } from '../../providers/k8s_provider';
import { cx } from '../../core/utils/cx';
import type { ResourceItem } from '../../types/k8s';

const YamlEditor = lazy(() => import('../../views/YamlEditor').then((m) => ({ default: m.YamlEditor })));

export const InspectorPanel: React.FC = () => {
  const selected = useResourceStore((s) => s.selectedItem);
  const history = useResourceStore((s) => s.selectionHistory);
  const resources = useResourceStore((s) => s.resources);
  const item = selected ? resources[selected.kind]?.get(selected.uid) : undefined;
  const close = () => useUiStore.setState({ inspectorCollapsed: true });
  return <ResourceDetails inspector item={item} onClose={close} onNavigate={(next) => next.kind === 'HelmRelease' ? useWorkspaceStore.getState().openHelmRelease(next) : useResourceStore.getState().selectItem(next)}
    onBack={history.length ? () => useResourceStore.getState().goBack() : undefined} />;
};

export function ResourceDetails({ item, onClose, onNavigate, onBack, inspector = false }: {
  item?: ResourceItem; onClose?: () => void; onNavigate: (item: ResourceItem) => void; onBack?: () => void; inspector?: boolean;
}) {
  const tabPrefix = useId();
  const [pfOpen, setPfOpen] = useState(false);
  const inspectorPinned = useUiStore((s) => s.inspectorPinned);
  const inspectorTab = useUiStore((s) => s.rightTab);
  const [localTab, setLocalTab] = useState<RightTab>('overview');
  const rightTab = inspector ? inspectorTab : localTab;
  const helm = useHelmGraph(item?.namespace, rightTab === 'related');
  const setTab = inspector ? useUiStore.getState().setRightTab : setLocalTab;
  const resources = useResourceStore((s) => s.resources);
  const [relatedQuery, setRelatedQuery] = useState('');
  const [relatedLimit, setRelatedLimit] = useState(50);
  useEffect(() => { setRelatedQuery(''); setRelatedLimit(50); }, [item?.uid]);
  // Related is lazy and inspects only adjacent edges, including Namespace membership.
  const graph = useMemo(() => item && rightTab === 'related' ? buildResourceGraph(resources, { adjacentTo: new Set([resourceKey(item)]) }) : undefined, [resources, item, rightTab]);
  if (!item) return <div className="h-full flex flex-col bg-[var(--bg-canvas)]">
    <div className="h-10 flex items-center px-3 gap-2 border-b border-[var(--border-default)]"><Boxes size="calc(14px * var(--ui-factor))" /><span className="flex-1">Resource details</span>{onClose && <IconButton icon={X} size="sm" onClick={onClose} aria-label="Close details" />}</div>
    <div className="flex-1 flex items-center justify-center p-8 text-center text-[var(--text-secondary)]"><div><Boxes size="calc(30px * var(--ui-factor))" className="mx-auto mb-3 opacity-50" /><p>Select a resource to inspect</p><p className="mt-1 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)]">Click a table row or a topology node. Details and related resources appear here.</p></div></div>
  </div>;
  const Icon = KIND_ICONS[item.kind];
  const key = resourceKey(item);
  const related = graph?.relations.filter((edge) => edge.source === key || edge.target === key) ?? [];
  const filteredRelated = related.filter((edge) => {
    const target = graph?.items.get(edge.source === key ? edge.target : edge.source);
    return [target?.name ?? edge.missing?.name, target?.kind ?? edge.missing?.kind, target?.namespace ?? edge.missing?.namespace, edge.type].join(' ').toLowerCase().includes(relatedQuery.toLowerCase());
  });
  const containers = podContainers(item).map((c) => c.name);
  const logs = (container?: string) => useDockStore.getState().openLogs(item.name, item.namespace, container, containers);
  const shell = (container?: string) => item.kind === 'Node' ? useDockStore.getState().openNodeShell(item.name) : useDockStore.getState().openTerminal(item.name, item.namespace, container, containers);
  const navigate = (next: ResourceItem) => { setTab('overview'); onNavigate(next); };
  return <div className="h-full flex flex-col bg-[var(--bg-canvas)] min-h-0" data-testid="resource-details">
    <div className="shrink-0 bg-[var(--bg-secondary)] border-b border-[var(--border-default)]">
      <div className="flex items-center gap-2 px-3 py-2">
        {onBack && <IconButton icon={ArrowLeft} size="sm" onClick={onBack} aria-label="Back to previous resource" />}
        <Icon size="calc(16px * var(--ui-factor))" className="text-[var(--accent)] shrink-0" />
        <div className="min-w-0 flex-1"><div className="font-mono text-xs truncate select-text" title={item.name}>{item.name}</div><div className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] mt-0.5">{item.kind} · {item.namespace || 'Cluster scoped'}</div></div>
        <IconButton icon={Copy} size="sm" aria-label="Copy resource name" tooltip="Copy resource name" onClick={() => { void navigator.clipboard.writeText(item.name).catch(() => toast.error('Clipboard unavailable')); }} />
        {inspector && <IconButton icon={Pin} size="sm" aria-label="Keep details on Overview" aria-pressed={inspectorPinned} active={inspectorPinned} tooltip="Keep details on Overview" onClick={() => useUiStore.setState({ inspectorPinned: !inspectorPinned })} />}
        <IconButton icon={ExternalLink} size="sm" aria-label="Open details in tab" tooltip="Open in editor tab" onClick={() => useWorkspaceStore.getState().openResourceDetail(item)} />
        {onClose && <IconButton icon={X} size="sm" onClick={onClose} aria-label="Close details" />}
      </div>
      <div className="flex flex-wrap gap-1.5 px-3 pb-2">
        {item.kind === 'Pod' && <Button size="sm" onClick={() => logs()}><FileText size="calc(12px * var(--ui-factor))" /> Logs</Button>}
        {['Pod', 'Node'].includes(item.kind) && <Button size="sm" onClick={() => shell()}><Terminal size="calc(12px * var(--ui-factor))" /> {item.kind === 'Node' ? 'Node shell' : 'Shell'}</Button>}
        {['Pod', 'Service'].includes(item.kind) && <Button size="sm" onClick={() => setPfOpen(true)}><ArrowRightLeft size="calc(12px * var(--ui-factor))" /> Ports</Button>}
        <Button size="sm" onClick={() => useWorkspaceStore.getState().openTopology(item.kind === 'Namespace' ? undefined : item, item.kind === 'Namespace' ? item.name : undefined)}><GitBranch size="calc(12px * var(--ui-factor))" /> Topology</Button>
      </div>
      <div role="tablist" aria-label="Resource details" className="flex px-2 overflow-x-auto">
        {(['overview', 'related', 'events', 'yaml'] as const).map((tab) => <button key={tab} role="tab" id={`${tabPrefix}-${tab}`} aria-controls={`${tabPrefix}-panel`} tabIndex={rightTab === tab ? 0 : -1} aria-selected={rightTab === tab} onKeyDown={(event) => {
          const tabs = ['overview', 'related', 'events', 'yaml'] as const;
          const index = tabs.indexOf(tab);
          const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[3] : event.key === 'ArrowRight' ? tabs[(index + 1) % 4] : event.key === 'ArrowLeft' ? tabs[(index + 3) % 4] : undefined;
          if (next) { event.preventDefault(); setTab(next); document.getElementById(`${tabPrefix}-${next}`)?.focus(); }
        }} onClick={() => setTab(tab)} className={cx('px-3 py-2 text-[length:calc(11px*var(--ui-factor))] border-b-2 whitespace-nowrap', rightTab === tab ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>{tab === 'related' ? graph ? `Related (${related.length})` : 'Related' : tab === 'yaml' ? 'YAML' : tab[0].toUpperCase() + tab.slice(1)}</button>)}
      </div>
    </div>
    <div role="tabpanel" id={`${tabPrefix}-panel`} aria-labelledby={`${tabPrefix}-${rightTab}`} className="flex-1 min-h-0 overflow-hidden">
      {rightTab === 'yaml' ? <Suspense fallback={<div className="p-4 text-[var(--text-muted)] flex gap-2"><Loader2 size="calc(13px * var(--ui-factor))" /> Loading editor…</div>}><YamlEditor key={item.uid} item={item} onApply={(yaml) => {
        if (!k8s.demo) { toast.error('Live manifest apply is not connected yet'); return; }
        useResourceStore.getState().updateItem(item.kind, item.uid, { ...mapK8sResource(parse(yaml), item.kind), uid: item.uid });
        toast.success('Manifest saved in demo memory');
      }} /></Suspense> : rightTab === 'related' ? <div className="h-full overflow-auto p-3"><NamespaceScopeNotice namespace={item.namespace ?? (item.kind === 'Namespace' ? item.name : undefined)} />{helm.loading && <p role="status" className="text-xs mb-2">Loading Helm relationships…</p>}{helm.error && <p className="text-xs text-[var(--status-warn)] mb-2">Helm relationships unavailable: {helm.error}</p>}<Card title="Resource relationships">
        <p className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)] mb-2">Resolved from owner references, selectors and explicit API references. Unloaded targets may require additional permissions.</p>
        <SearchInput value={relatedQuery} onChange={(value) => { setRelatedQuery(value); setRelatedLimit(50); }} placeholder="Filter related resources…" className="mb-2 w-full" />
        <div className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] mb-2">{filteredRelated.length} matching · {related.length} relationships</div>
        {!related.length && <p className="text-[var(--text-secondary)] text-xs">No relationships found in loaded resources.</p>}
        {filteredRelated.slice(0, relatedLimit).map((edge) => {
          const outgoing = edge.source === key;
          const target = edge.missing ? undefined : graph?.items.get(outgoing ? edge.target : edge.source);
          return <button key={edge.id} disabled={!target} onClick={() => target && navigate(target)} className="w-full flex items-center gap-2 px-2 py-2 border-b border-[var(--border-subtle)] text-left hover:bg-[var(--bg-hover)] disabled:opacity-60">
            {outgoing ? <ArrowRight size="calc(12px * var(--ui-factor))" /> : <ArrowLeft size="calc(12px * var(--ui-factor))" />}<div className="flex-1 min-w-0"><div className="flex items-start gap-2 text-xs font-mono break-all">{target && <ResourceWarnings item={target} />}<span>{target?.name ?? edge.missing?.name}</span></div><div className="flex flex-wrap items-center gap-1.5 mt-1.5 text-[length:calc(10px*var(--ui-factor))] text-[var(--text-secondary)]"><ResourceKindBadge kind={target?.kind ?? edge.missing?.kind ?? 'Resource'} /><span>{target?.namespace ?? edge.missing?.namespace ?? 'cluster'}{!target && ' · not loaded'}</span></div></div><span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-secondary)]">{edge.label}</span>
          </button>;
        })}
        {filteredRelated.length > relatedLimit && <Button size="sm" className="mt-3" onClick={() => setRelatedLimit((limit) => limit + 50)}>Show next 50</Button>}
        {!!related.length && !filteredRelated.length && <p className="text-xs text-[var(--text-muted)]">No related resources match this filter.</p>}
      </Card></div> : rightTab === 'events' ? <ResourceEvents key={item.uid} item={item} /> : <Overview key={item.uid} item={item} onNavigate={navigate} onLogs={logs} onShell={shell} />}
    </div>
    <PFDialog key={item.uid} item={pfOpen ? item : null} onClose={() => setPfOpen(false)} />
  </div>;
}

function Overview({ item, onNavigate, onLogs, onShell }: { item: ResourceItem; onNavigate: (item: ResourceItem) => void; onLogs: (container?: string) => void; onShell: (container?: string) => void }) {
  const resources = useResourceStore((s) => s.resources);
  const raw = item.raw ?? {};
  const spec = raw.spec ?? item.spec ?? {};
  const status = raw.status ?? item.statusRaw ?? {};
  const metadata = raw.metadata ?? item.metadata ?? {};
  const conditions: any[] = status.conditions ?? [];
  const namespace = [...resources.Namespace.values()].find((r) => r.name === item.namespace);
  const node = [...resources.Node.values()].find((r) => r.name === item.node);
  const data = raw.data ?? {};
  return <div className="h-full overflow-y-auto kubiki-scrollbar p-3 flex flex-col gap-3 select-text">
    <div className="flex items-center gap-3 px-1 py-1">{item.status && <StatusBadge status={item.status} />}<span className="text-[var(--text-secondary)] font-mono text-xs">{item.ready && `Ready ${item.ready}`}</span>{item.restarts !== undefined && <span className="text-[var(--text-secondary)] text-[length:calc(11px*var(--ui-factor))]">{item.restarts} restarts</span>}</div>
    <div className="shrink-0"><ResourceWarnings item={item} showSummary /></div>
    <Card title="Metadata"><MetaGrid rows={[
      ['Name', item.name], ['Kind', item.kind], ['Namespace', namespace ? <ResourceLink item={namespace} onClick={onNavigate} /> : item.namespace ?? 'Cluster scoped'],
      ['API version', item.apiVersion], ['Created', item.creationTimestamp], ['Age', item.age], ['UID', item.uid],
      ['Node', node ? <ResourceLink item={node} onClick={onNavigate} /> : item.node], ['Pod IP', item.ip], ['Service type', item.serviceType], ['Cluster IP', item.clusterIP],
      ['Storage class', item.storageClass], ['Volume', item.volume], ['Version', item.nodeVersion], ['Roles', item.nodeRoles], ['Hosts', item.ingressHosts],
    ]} /></Card>
    {!!conditions.length && <Card title="Conditions">{conditions.map((c) => <div key={c.type} className="py-1.5 border-b border-[var(--border-subtle)]"><div className="flex justify-between gap-2 text-xs"><span>{c.type}</span><span className={c.status === 'True' ? 'text-[var(--status-ok)]' : 'text-[var(--text-secondary)]'}>{c.status}</span></div><div className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] mt-1 break-words">{c.reason}{c.message ? ` · ${c.message}` : ''}</div></div>)}</Card>}
    {!!item.containers?.length && <Card title={`Containers (${item.containers.length})`}>{item.containers.map((c) => {
      const containerSpec = [...(spec.containers ?? []), ...(spec.initContainers ?? []), ...(spec.ephemeralContainers ?? [])].find((s: any) => s.name === c.name) ?? {};
      const cs = [...(status.containerStatuses ?? []), ...(status.initContainerStatuses ?? []), ...(status.ephemeralContainerStatuses ?? [])].find((s: any) => s.name === c.name);
      return <div key={c.name} className="py-2 border-b border-[var(--border-subtle)]"><div className="flex items-center gap-2"><ContainerStatusIcon container={c} /><span className="font-mono text-xs flex-1">{c.name}</span><span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)]">{CONTAINER_ROLE_LABEL[c.role ?? 'application']}</span><IconButton icon={FileText} size="sm" onClick={() => onLogs(c.name)} aria-label={`Logs for ${c.name}`} /><IconButton icon={Terminal} size="sm" disabled={!canExecContainer(c)} tooltip={!canExecContainer(c) ? c.reason ?? c.state : undefined} onClick={() => onShell(c.name)} aria-label={`Shell for ${c.name}`} /></div><div className="font-mono text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] break-all mt-1">{c.image}</div><MetaGrid rows={[
        ['Ports', c.port], ['Restarts', String(c.restarts)], ['State', cs?.state ? Object.keys(cs.state).join(', ') : undefined],
        ['Requests', containerSpec.resources?.requests ? JSON.stringify(containerSpec.resources.requests) : undefined], ['Limits', containerSpec.resources?.limits ? JSON.stringify(containerSpec.resources.limits) : undefined],
        ['Readiness probe', containerSpec.readinessProbe ? JSON.stringify(containerSpec.readinessProbe) : undefined], ['Liveness probe', containerSpec.livenessProbe ? JSON.stringify(containerSpec.livenessProbe) : undefined],
      ]} /></div>;
    })}</Card>}
    {!!spec.volumes?.length && <Card title="Volumes">{spec.volumes.map((v: any) => <div key={v.name} className="py-1 text-[length:calc(11px*var(--ui-factor))]"><span className="font-mono">{v.name}</span><span className="ml-2 text-[var(--text-muted)]">{Object.keys(v).filter((key) => key !== 'name').join(', ')}</span></div>)}</Card>}
    {item.kind === 'Secret' && <SecretDataEditor key={item.uid} item={item} />}
    {item.kind === 'ConfigMap' && <Card title="Configuration data">
      {!Object.keys(data).length && <span className="text-xs text-[var(--text-muted)]">No data keys</span>}
      {Object.entries(data).map(([key, value]) => <div key={key} className="mt-2"><div className="text-xs font-mono text-[var(--text-secondary)]">{key}</div><pre tabIndex={0} aria-label={`Value for ${key}`} className="resource-data-value kubiki-scrollbar text-xs whitespace-pre-wrap break-all mt-1">{String(value)}</pre></div>)}
    </Card>}
    <Card title="Labels"><KeyValues values={item.labels ?? metadata.labels ?? {}} /></Card>
    {!!Object.keys(metadata.annotations ?? {}).length && <Card title={`Annotations (${Object.keys(metadata.annotations).length})`}><ResourceAnnotations values={metadata.annotations} /></Card>}
  </div>;
}

function ResourceEvents({ item }: { item: ResourceItem }) {
  const events = useResourceStore((s) => s.resources.Event);
  const error = useResourceStore((s) => s.loadErrors.Event);
  const watchState = useResourceStore((s) => s.watchStates.Event);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(50);
  const related = useMemo(() => resourceEvents(events.values(), item), [events, item]);
  const filtered = related.filter((entry) => [entry.reason, entry.message, entry.warning ? 'Warning' : 'Normal', entry.reporter].join(' ').toLowerCase().includes(query.toLowerCase()));
  return <div className="h-full overflow-auto p-3">
    <NamespaceScopeNotice namespace={item.namespace} />
    <Card title="Resource events">
      <p className="text-xs text-[var(--text-muted)] mb-3">Notifications for {item.kind}/{item.name} only. Newest first; events for child resources are shown on those objects.</p>
      {error && <p role="status" className="text-[var(--status-warn)] text-xs mb-2">{error.message} Loaded events may be incomplete or stale.</p>}
      {watchState && watchState.phase !== 'live' && <p role="status" className="text-xs text-[var(--text-muted)] mb-2">Event watch: {watchState.phase}. {watchState.hasSnapshot ? 'Showing the last loaded snapshot.' : 'Waiting for an event snapshot.'}</p>}
      <SearchInput value={query} onChange={(value) => { setQuery(value); setLimit(50); }} placeholder="Filter events by reason, message or type…" className="w-full mb-2" />
      <div className="text-xs text-[var(--text-muted)] mb-2">{filtered.length} matching · {related.length} events · {related.filter((entry) => entry.warning).length} warnings</div>
      {!related.length && <p className="text-xs text-[var(--text-muted)]">No events for this object in the loaded snapshot. Events are retained temporarily by Kubernetes.</p>}
      {!!related.length && !filtered.length && <p className="text-xs text-[var(--text-muted)]">No events match this filter.</p>}
      {filtered.slice(0, limit).map((entry) => <article key={entry.event.uid} aria-label={entry.reason} className="py-3 border-b border-[var(--border-default)]">
        <div className="flex flex-wrap items-center gap-2 text-xs"><span className={entry.warning ? 'text-[var(--status-warn)]' : 'text-[var(--status-ok)]'}>{entry.warning ? 'Warning' : 'Normal'}</span><strong className="break-all">{entry.reason}</strong><span className="text-[var(--text-muted)]">×{entry.count}</span></div>
        <p className="text-xs text-[var(--text-secondary)] mt-1 whitespace-pre-wrap break-words">{entry.message}</p>
        <div className="flex flex-wrap gap-x-2 mt-2 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)]">{entry.timestamp ? <time dateTime={entry.timestamp} title={entry.timestamp}>{new Date(entry.time).toLocaleString()}</time> : <span>Time unavailable</span>}{entry.reporter && <span className="break-all">{entry.reporter}</span>}</div>
      </article>)}
      {filtered.length > limit && <Button size="sm" className="mt-3" onClick={() => setLimit((value) => value + 50)}>Show next 50</Button>}
    </Card>
  </div>;
}
function ResourceLink({ item, onClick }: { item: ResourceItem; onClick: (item: ResourceItem) => void }) { return <button className="text-[var(--accent)] hover:underline text-left break-all" onClick={() => onClick(item)}>{item.name}</button>; }
function KeyValues({ values }: { values: Record<string, unknown> }) { return Object.keys(values).length ? <div className="space-y-2">{Object.entries(values).map(([key, value]) => <div key={key} className="text-[length:calc(11px*var(--ui-factor))] break-all"><span className="text-[var(--text-secondary)]">{key}</span><div className="font-mono mt-0.5 whitespace-pre-wrap">{String(value)}</div></div>)}</div> : <span className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)]">None</span>; }
function Card({ title, children }: { title: string; children: React.ReactNode }) { return <section aria-label={title} className="shrink-0 border border-[var(--border-default)] rounded-md overflow-hidden"><div className="px-3 py-2 text-[length:calc(11px*var(--ui-factor))] font-medium text-[var(--text-secondary)] bg-[var(--bg-secondary)]">{title}</div><div className="p-3">{children}</div></section>; }
function MetaGrid({ rows }: { rows: Array<[string, React.ReactNode]> }) { return <dl className="grid grid-cols-[calc(100px*var(--ui-factor))_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[length:calc(11px*var(--ui-factor))] mt-1">{rows.filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => <React.Fragment key={key}><dt className="text-[var(--text-secondary)]">{key}</dt><dd className="font-mono break-all min-w-0">{value}</dd></React.Fragment>)}</dl>; }
