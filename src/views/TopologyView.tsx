import { useTopologyGraph } from '../providers/use_topology_graph';
import './topology.css';
import { namespaceNames, namespaceScope } from '../core/resources/namespace_scope';
import { EMPTY_GRAPH, topologyNamespaces } from '../core/resources/topology';
import { NamespaceSelect } from '../components/ui/NamespaceSelect';
import { useEffect, useMemo, useState } from 'react';
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
import { fastCompare } from '../core/resources/resource_sort';
import { topologyResourceKinds } from '../core/resources/resource_demand';
import { topologyReadiness } from '../core/resources/topology_readiness';
import type { ResourceGraph } from '../core/resources/relationships';
import { retainResourceKinds } from '../state/resource_requirements';

const NO_EVENTS = new Map<string, ResourceItem>();

export function TopologyView({ item, namespace, visible = true }: { item?: ResourceItem; namespace?: string; visible?: boolean }) {
  const updateInterval = useUiStore(s => topologyRendering(s).updateIntervalMs);
  const resources = useResourceStore(useShallow((s) => ({ ...s.resources, Event: NO_EVENTS })));
  const syncMode = useResourceStore((s) => s.syncMode);
  const watchStates = useResourceStore((s) => s.watchStates);
  const errors = useResourceStore((s) => s.loadErrors);
  const loadingKinds = useResourceStore(s => s.loadingKinds);
  const availableKinds = useClusterStore(s => s.availableResourceKinds);
  const connected = useClusterStore(s => s.isConnected);
  const clusterLoading = useClusterStore(s => s.isLoading);
  const namespaces = useClusterStore((s) => s.availableNamespaces);
  const selectedNamespace = useClusterStore((s) => s.selectedNamespace);
  const context = useClusterStore((s) => s.currentContext);
  const podsCurrent = useResourceStore((s) => s.syncMode !== 'watch' || s.watchStates.Pod?.phase === 'live');
  const snapshotsReady = useClusterStore((s) => s.isConnected && !s.isLoading);
  const [scope, setScope] = useState(() => item?.kind === 'Event' ? item.namespace ? `namespace:${item.namespace}` : '' : item ? 'resource' : namespace === 'all' ? 'all' : namespace ? namespace.startsWith('[') ? `namespaces:${namespace}` : `namespace:${namespace}` : '');
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
  const requestNamespace = diagramNamespace ?? selectedNamespace;
  const helm = useHelmGraph(diagramNamespace, visible && !outsideScope && !!graphScope && scope !== 'overview');
  const inputState = { context, namespace: requestNamespace, availableKinds, mode: syncMode, connected, clusterLoading, watches: watchStates, loading: loadingKinds, errors };
  const { graph: candidate, key: graphKey, notice, loading, prepared } = useTopologyGraph(resources, graphScope, item, depth,
    visible && !outsideScope && !!graphScope && scope !== 'overview', updateInterval, {
      context,
      requirements: graph => JSON.stringify(topologyResourceKinds(graphScope, item, depth, graph).sort()),
      ready: graph => topologyReadiness({ ...inputState, kinds: topologyResourceKinds(graphScope, item, depth, graph) }).ready && helm.ready,
    });
  const requiredKinds = useMemo(() => outsideScope ? [] : topologyResourceKinds(graphScope, item, depth, candidate).sort(), [candidate, graphScope, item, depth, outsideScope]);
  // Dependency discovery may need several internal graph passes for focused views.
  // Publish only after their required snapshots have reached a fixed point.
  const [published, setPublished] = useState<{ key: string; graph: ResourceGraph }>();
  useEffect(() => {
    if (!visible || !graphScope || scope === 'overview' || !prepared || loading || notice) return;
    setPublished(previous => previous?.key === graphKey && previous.graph === candidate ? previous : {key: graphKey, graph: candidate});
  }, [visible, graphScope, scope, prepared, loading, notice, graphKey, candidate]);
  const currentGraph = published?.key === graphKey ? published.graph : undefined;
  const graph = currentGraph ?? EMPTY_GRAPH;
  const requirementKey = JSON.stringify(requiredKinds);
  useEffect(() => {
    if (!visible || !context || !requiredKinds.length) return;
    return retainResourceKinds(context, JSON.parse(requirementKey) as ResourceKind[], requestNamespace);
  }, [visible, context, requirementKey, requestNamespace]);
  const chooseScope = !graphScope || scope === 'overview';
  const readiness = topologyReadiness({...inputState, kinds: requiredKinds});
  const unavailable = readiness.unavailable;
  const namespaceOptions = useMemo(() => {
    const names = new Set([...namespaces, ...(namespaceNames(selectedNamespace) ?? [])]);
    for (const namespace of resources.Namespace.values()) names.add(namespace.name);
    for (const item of graph.items.values()) if (item.namespace) names.add(item.namespace);
    return [...names].sort(fastCompare);
  }, [namespaces, selectedNamespace, resources.Namespace, graph.items]);
  const visibleCount = useMemo(() => [...graph.items.values()].filter(item => !hiddenKinds.has(item.kind)).length, [graph, hiddenKinds]);
  const typeCounts = useMemo(() => topologyTypeCounts(graph), [graph]);
  const chooseNamespaces = (selection: string) => setScope(selection === 'all' ? 'all' : `namespaces:${selection}`);
  const warningCount = useMemo(() => {
    let podsByNamespace: Map<string | undefined, ResourceItem[]> | undefined;
    let storageClasses: Map<string, ResourceItem> | undefined;
    const podsLoaded = snapshotsReady && podsCurrent && !errors.Pod;
    return [...graph.items.values()].filter((resource) => {
      if (resource.kind === 'Service') {
        if (!podsByNamespace) {
          podsByNamespace = new Map();
          for (const pod of resources.Pod.values()) {
            const list = podsByNamespace.get(pod.namespace);
            if (list) list.push(pod);
            else podsByNamespace.set(pod.namespace, [pod]);
          }
        }
        return resourceIssues(resource, {
          pods: podsByNamespace.get(resource.namespace) ?? [],
          podsLoaded,
        }).length > 0;
      }
      if (resource.kind === 'PersistentVolumeClaim') {
        if (!storageClasses) {
          storageClasses = new Map([...resources.StorageClass.values()].map((entry) => [entry.name, entry]));
        }
        const storageClassName = resource.spec?.storageClassName ?? resource.storageClass;
        return resourceIssues(resource, {
          storageClass: typeof storageClassName === 'string' ? storageClasses.get(storageClassName) : undefined,
        }).length > 0;
      }
      return resourceIssues(resource).length > 0;
    }).length;
  }, [graph, resources.Pod, resources.StorageClass, snapshotsReady, podsCurrent, errors.Pod]);

  return <div className="h-full min-h-0 min-w-0 flex flex-col topology-view" data-scope={scope} data-phase={outsideScope ? 'outside' : !graphScope || scope === 'overview' ? 'choose' : notice ? 'failed' : currentGraph ? 'ready' : 'loading'}>
    {outsideScope ? <div role="status" className="px-3 py-2 text-xs border-b border-[var(--border-default)] flex flex-wrap gap-2 items-center">
      <span>Some diagram namespaces are outside the loaded selection.</span><Button size="sm" onClick={() => setScope('')}>Change scope</Button><Button size="sm" onClick={() => useClusterStore.getState().selectNamespace(graphScope === 'all' ? 'all' : namespaceScope([...new Set([...(namespaceNames(selectedNamespace) ?? []), ...diagramNamespaces, ...(scope === 'resource' && item?.namespace ? [item.namespace] : [])])]))}>{graphScope === 'all' ? 'Load all namespaces' : 'Load diagram namespaces'}</Button>
    </div> : <NamespaceScopeNotice /> }
    {helm.error && <p className="px-3 py-1 text-xs text-[var(--status-warn)]">Helm relationships unavailable: {helm.error} Kubernetes resources are still shown.</p>}
    {unavailable.length > 0 && <div className="px-3 py-1 text-[length:calc(11px*var(--ui-factor))] text-[var(--status-warn)]">Some resource types are unavailable. This diagram shows loaded resources only.</div>}
    <div className="topology-body relative overflow-hidden">
      {outsideScope ? <div className="p-6 text-sm text-[var(--text-secondary)]">Load this namespace using the button above to build its diagram.</div> : chooseScope ? <div className="h-full overflow-auto p-6">
        <h2 className="text-sm font-medium">Choose a diagram scope</h2>
        <p className="text-xs text-[var(--text-secondary)] mt-2 max-w-xl">Select one or more namespaces, use the global selection, or open Topology from a resource. Choose All Namespaces to draw the entire loaded cluster.</p>
        <div className="topology-initial-namespace"><NamespaceSelect label="Diagram namespaces" value={selectedNamespace} options={namespaceOptions} onChange={chooseNamespaces} /></div>
        <div className="topology-scope-actions">
          <Button onClick={() => setScope('all')}>All Namespaces</Button>
          <Button onClick={() => setScope('selection')}>Use global selection</Button>
          <Button onClick={() => setScope('overview')}>Cluster summary</Button>
        </div>
        <SearchInput value={scopeQuery} onChange={setScopeQuery} placeholder="Find namespace…" className="mt-4 max-w-sm" />
        <div className="grid gap-2 mt-3 max-w-2xl">{namespaceOptions.filter(name => name.toLowerCase().includes(scopeQuery.toLowerCase())).map(name => <button key={name} onClick={() => setScope(`namespace:${name}`)} className="flex items-center gap-3 text-left px-3 py-2 rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] hover:border-[var(--accent)]">
          <span className="font-mono text-xs flex-1 truncate">{name}</span>
        </button>)}</div>
        {!namespaceOptions.length && <p className="text-xs text-[var(--text-muted)] mt-4">No namespaces have been loaded. Open a resource topology from its details.</p>}
      </div> : notice ? <div role="alert" className="p-6 text-[var(--status-warn)] text-xs"><TriangleAlert size="calc(18px * var(--ui-factor))" className="mb-2" />{notice}<p className="mt-2 text-[var(--text-secondary)]">No graph was sent to the layout worker. Select fewer namespaces, use fewer hops, or open a specific workload or Pod.</p><Button size="sm" className="mt-3" onClick={() => setScope('')}>Choose another scope</Button></div> : <>{currentGraph ? <TopologyCanvas key={graphKey} graph={graph} direction={direction} revision={revision} routeRevision={routeRevision} hiddenKinds={hiddenKinds} focusKey={item ? resourceKey(item) : undefined} /> : <div role="status" className="h-full flex items-center justify-center text-sm text-[var(--text-secondary)]">{readiness.pending.length ? `Loading topology resources… ${readiness.pending.length} types remaining` : !helm.ready ? 'Loading Helm relationships…' : 'Preparing topology relationships…'}</div>}
        <div className="topology-summary" title={visibleCount !== graph.items.size ? 'Visible resources / all loaded resources' : undefined}>{currentGraph ? <>{visibleCount === graph.items.size ? graph.items.size : `${visibleCount}/${graph.items.size}`} resources · {graph.relations.length} links</> : 'Loading resources…'}{warningCount > 0 && <span className="text-[var(--status-warn)]"> · {warningCount} with issues</span>}
          {loading && <span role="status" className="block text-[var(--text-secondary)]">Updating topology relationships…</span>}
        </div>
        <div className="topology-islands">
          <TopologySettings namespace={diagramNamespace ?? selectedNamespace} namespaces={namespaceOptions} onNamespaceChange={chooseNamespaces} onUseSelection={() => setScope('selection')} onChooseScope={() => setScope('')}
            focusLabel={item && item.kind !== 'Event' ? `${item.kind}/${item.name}` : undefined} onFocus={() => setScope('resource')}
            direction={direction} onDirectionChange={setDirection} depth={scope === 'resource' ? depth : undefined} onDepthChange={setDepth}
            onArrange={() => setRevision(value => value + 1)} onResetRoutes={() => setRouteRevision(value => value + 1)} counts={typeCounts} hiddenKinds={hiddenKinds} onHiddenKindsChange={updateHiddenKinds} onDefaultKinds={() => updateHiddenKinds(new Set(DEFAULT_TOPOLOGY_HIDDEN_KINDS))} />
          <TopologyEvents scope={graphScope} graph={graph} />
        </div></>}
    </div>
    <div className="px-3 py-1 border-t border-[var(--border-default)] text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)]">Click to inspect · Double-click to focus · Drag blocks to arrange · Select arrows to edit bends and segments</div>
  </div>;
}
