import { useTopologyGraph } from '../providers/use_topology_graph';
import './topology.css';
import { namespaceNames, namespaceScope } from '../core/resources/namespace_scope';
import { topologyNamespaces } from '../core/resources/topology';
import { NamespaceSelect } from '../components/ui/NamespaceSelect';
import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import '@xyflow/react/dist/style.css';
import { TriangleAlert } from 'lucide-react';
import { useResourceStore } from '../state/resource_store';
import { useClusterStore } from '../state/cluster_store';
import { useUiStore } from '../state/ui_store';
import { DEFAULT_TOPOLOGY_HIDDEN_KINDS } from '../core/resources/topology_visibility';
import { resourceKey } from '../core/resources/identity';
import { resourceIssues } from '../core/resources/diagnostics';
import { Button } from '../components/ui/Button';
import { SearchInput } from '../components/ui/Input';
import { TopologySettings } from './TopologySettings';
import { topologyTypeCounts } from '../core/resources/topology_visibility';
import type { ResourceKind } from '../types/k8s';
import type { ResourceItem } from '../types/k8s';
import { NamespaceScopeNotice } from '../components/k8s/NamespaceScopeNotice';
import { namespaceIsOutsideScope } from '../core/resources/resource_types';
import { TopologyCanvas } from './TopologyCanvas';
import { TopologyEvents } from './TopologyEvents';
import { useHelmGraph } from '../providers/use_helm_graph';
import { topologyRendering } from '../core/resources/topology_rendering';

const NO_EVENTS = new Map<string, ResourceItem>();

export function TopologyView({ item, namespace }: { item?: ResourceItem; namespace?: string }) {
  const updateInterval = useUiStore(s => topologyRendering(s).updateIntervalMs);
  const resources = useResourceStore(useShallow((s) => ({ ...s.resources, Event: NO_EVENTS })));
  const syncMode = useResourceStore((s) => s.syncMode);
  const watchStates = useResourceStore((s) => s.watchStates);
  const errors = useResourceStore((s) => s.loadErrors);
  const namespaces = useClusterStore((s) => s.availableNamespaces);
  const selectedNamespace = useClusterStore((s) => s.selectedNamespace);
  const podsCurrent = useResourceStore((s) => s.syncMode !== 'watch' || s.watchStates.Pod?.phase === 'live');
  const snapshotsReady = useClusterStore((s) => s.isConnected && !s.isLoading);
  const [scope, setScope] = useState(() => item?.kind === 'Event' ? item.namespace ? `namespace:${item.namespace}` : '' : item ? 'resource' : namespace ? namespace.startsWith('[') ? `namespaces:${namespace}` : `namespace:${namespace}` : '');
  const [depth, setDepth] = useState(2);
  const [direction, setDirection] = useState<'RIGHT' | 'DOWN'>('RIGHT');
  const [revision, setRevision] = useState(0);
  const [routeRevision, setRouteRevision] = useState(0);
  /* Secondary kinds start hidden from the persisted store; a focused resource
     diagram keeps everything visible so its relationships are not lost. */
  const [hiddenKinds, setHiddenKinds] = useState<Set<ResourceKind>>(() => item ? new Set() : new Set(useUiStore.getState().topologyHiddenKinds));
  const updateHiddenKinds = (next: Set<ResourceKind>) => { setHiddenKinds(next); useUiStore.getState().setTopologyHiddenKinds(next); };
  const [scopeQuery, setScopeQuery] = useState('');
  const graphScope = scope === 'selection' ? selectedNamespace === 'all' ? 'all' : `namespaces:${selectedNamespace}` : scope;
  const diagramNamespaces = topologyNamespaces(graphScope);
  const diagramNamespace = scope === 'resource' ? item?.namespace ?? (item?.kind === 'Namespace' ? item.name : undefined)
    : graphScope === 'all' ? 'all' : diagramNamespaces.length ? namespaceScope(diagramNamespaces) : undefined;
  const outsideScope = graphScope === 'all' ? selectedNamespace !== 'all' : (diagramNamespaces.length ? diagramNamespaces : diagramNamespace ? [diagramNamespace] : []).some(name => namespaceIsOutsideScope(name, selectedNamespace, syncMode));
  const helm = useHelmGraph(diagramNamespace, !outsideScope && !!graphScope && scope !== 'overview');
  const namespaceLoaded = (name: string) => !namespaceIsOutsideScope(name, selectedNamespace, syncMode);
  const synchronizing = syncMode === 'watch' && Object.values(watchStates).some((state) => state?.phase === 'connecting' || state?.phase === 'syncing');
  const summaries = useMemo(() => {
    const counts = new Map([...new Set([...namespaces, ...(namespaceNames(selectedNamespace) ?? [])])].map((name) => [name, { name, resources: 0, pods: 0 }]));
    for (const map of Object.values(resources)) for (const item of map.values()) {
      const name = item.namespace ?? (item.kind === 'Namespace' ? item.name : undefined);
      if (!name) continue;
      if (!counts.has(name)) counts.set(name, { name, resources: 0, pods: 0 });
      if (item.namespace) counts.get(name)!.resources++;
      if (item.kind === 'Pod') counts.get(name)!.pods++;
    }
    return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [resources, namespaces, selectedNamespace]);
  const { graph, notice, loading } = useTopologyGraph(resources, graphScope, item, depth, !outsideScope, updateInterval);
  const chooseScope = !graphScope || scope === 'overview';
  const typeCounts = useMemo(() => topologyTypeCounts(graph), [graph]);
  const chooseNamespaces = (selection: string) => setScope(selection === 'all' ? 'all' : `namespaces:${selection}`);
  const warningCount = useMemo(() => {
    const pods = [...resources.Pod.values()];
    const storageClasses = new Map([...resources.StorageClass.values()].map((entry) => [entry.name, entry]));
    return [...graph.items.values()].filter((resource) => {
      const storageClassName = resource.spec?.storageClassName ?? resource.storageClass;
      return resourceIssues(resource, {
        pods,
        podsLoaded: snapshotsReady && podsCurrent && !errors.Pod,
        storageClass: typeof storageClassName === 'string' ? storageClasses.get(storageClassName) : undefined,
      }).length > 0;
    }).length;
  }, [graph, resources.Pod, resources.StorageClass, snapshotsReady, podsCurrent, errors.Pod]);

  return <div className="h-full min-h-0 min-w-0 flex flex-col topology-view" data-scope={scope}>
    {outsideScope ? <div role="status" className="px-3 py-2 text-xs border-b border-[var(--border-default)] flex flex-wrap gap-2 items-center">
      <span>Some diagram namespaces are outside the loaded selection.</span><Button size="sm" onClick={() => setScope('')}>Change scope</Button><Button size="sm" onClick={() => useClusterStore.getState().selectNamespace(graphScope === 'all' ? 'all' : namespaceScope([...new Set([...(namespaceNames(selectedNamespace) ?? []), ...diagramNamespaces, ...(scope === 'resource' && item?.namespace ? [item.namespace] : [])])]))}>{graphScope === 'all' ? 'Load all namespaces' : 'Load diagram namespaces'}</Button>
    </div> : <NamespaceScopeNotice /> }
    {helm.loading && <p role="status" className="px-3 py-1 text-xs text-[var(--text-secondary)]">Loading Helm relationships…</p>}
    {helm.error && <p className="px-3 py-1 text-xs text-[var(--status-warn)]">Helm relationships unavailable: {helm.error} Kubernetes resources are still shown.</p>}
    {synchronizing && <p role="status" className="px-3 py-1 text-xs text-[var(--text-secondary)]">Resources are synchronizing. Counts and relationships may be incomplete.</p>}
    {!!Object.values(errors).filter(Boolean).length && <div className="px-3 py-1 text-[length:calc(11px*var(--ui-factor))] text-[var(--status-warn)]">Some resource types are unavailable. This diagram shows loaded resources only.</div>}
    <div className="topology-body relative overflow-hidden">
      {outsideScope ? <div className="p-6 text-sm text-[var(--text-secondary)]">Load this namespace using the button above to build its diagram.</div> : chooseScope ? <div className="h-full overflow-auto p-6">
        <h2 className="text-sm font-medium">Choose a diagram scope</h2>
        <p className="text-xs text-[var(--text-secondary)] mt-2 max-w-xl">Select one or more namespaces, use the global selection, or open Topology from a resource. Choose All Namespaces to draw the entire loaded cluster.</p>
        <p className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)] mt-2">No resource count or link limit. Up to 10 seconds for automatic layout. Cluster summary shows counts only.</p>
        <div className="topology-initial-namespace"><NamespaceSelect label="Diagram namespaces" value={selectedNamespace} options={summaries.map(summary => summary.name)} onChange={chooseNamespaces} /></div>
        <div className="topology-scope-actions">
          <Button onClick={() => setScope('all')}>All Namespaces</Button>
          <Button onClick={() => setScope('selection')}>Use global selection</Button>
          <Button onClick={() => setScope('overview')}>Cluster summary</Button>
        </div>
        <SearchInput value={scopeQuery} onChange={setScopeQuery} placeholder="Find namespace…" className="mt-4 max-w-sm" />
        <div className="grid gap-2 mt-3 max-w-2xl">{summaries.filter((summary) => summary.name.toLowerCase().includes(scopeQuery.toLowerCase())).slice(0, 50).map((summary) => <button key={summary.name} onClick={() => setScope(`namespace:${summary.name}`)} className="flex items-center gap-3 text-left px-3 py-2 rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] hover:border-[var(--accent)]">
          <span className="font-mono text-xs flex-1 truncate">{summary.name}</span><span className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)]">{namespaceLoaded(summary.name) ? `${summary.resources} resources · ${summary.pods} Pods` : 'Not loaded'}</span>
        </button>)}</div>
        {!summaries.length && <p className="text-xs text-[var(--text-muted)] mt-4">No namespaces have been loaded. Open a resource topology from its details.</p>}
      </div> : notice ? <div role="alert" className="p-6 text-[var(--status-warn)] text-xs"><TriangleAlert size="calc(18px * var(--ui-factor))" className="mb-2" />{notice}<p className="mt-2 text-[var(--text-secondary)]">No graph was sent to the layout worker. Select fewer namespaces, use fewer hops, or open a specific workload or Pod.</p><Button size="sm" className="mt-3" onClick={() => setScope('')}>Choose another scope</Button></div> : <><TopologyCanvas graph={graph} direction={direction} revision={revision} routeRevision={routeRevision} hiddenKinds={hiddenKinds} focusKey={item ? resourceKey(item) : undefined} />
        <div className="topology-summary">{graph.items.size} resources · {graph.relations.length} links{warningCount > 0 && <span className="text-[var(--status-warn)]"> · {warningCount} with issues</span>}
          {loading && <span role="status" className="block text-[var(--text-secondary)]">Updating topology relationships…</span>}
        </div>
        <div className="topology-islands">
          <TopologySettings namespace={diagramNamespace ?? selectedNamespace} namespaces={summaries.map(summary => summary.name)} onNamespaceChange={chooseNamespaces} onUseSelection={() => setScope('selection')} onChooseScope={() => setScope('')}
            focusLabel={item && item.kind !== 'Event' ? `${item.kind}/${item.name}` : undefined} onFocus={() => setScope('resource')}
            direction={direction} onDirectionChange={setDirection} depth={scope === 'resource' ? depth : undefined} onDepthChange={setDepth}
            onArrange={() => setRevision(value => value + 1)} onResetRoutes={() => setRouteRevision(value => value + 1)} counts={typeCounts} hiddenKinds={hiddenKinds} onHiddenKindsChange={updateHiddenKinds} onDefaultKinds={() => updateHiddenKinds(new Set(DEFAULT_TOPOLOGY_HIDDEN_KINDS))} />
          <TopologyEvents scope={graphScope} graph={graph} />
        </div></>}
    </div>
    <div className="px-3 py-1 border-t border-[var(--border-default)] text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)]">Click to inspect · Double-click to focus · Drag blocks to arrange · Select arrows to edit bends and segments</div>
  </div>;
}
