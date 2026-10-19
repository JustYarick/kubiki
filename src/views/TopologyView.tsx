import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import '@xyflow/react/dist/style.css';
import { GitBranch, RotateCw, TriangleAlert } from 'lucide-react';
import { useResourceStore } from '../state/resource_store';
import { useClusterStore } from '../state/cluster_store';
import { buildTopology, EMPTY_GRAPH, MAX_TOPOLOGY_NODES, MAX_TOPOLOGY_EDGES } from '../core/resources/topology';
import { resourceKey } from '../core/resources/identity';
import { resourceIssues } from '../core/resources/diagnostics';
import { Button } from '../components/ui/Button';
import { SearchInput } from '../components/ui/Input';
import { SearchableSelect } from '../components/ui/SearchableSelect';
import type { ResourceItem } from '../types/k8s';
import { TopologyCanvas } from './TopologyCanvas';
import { TopologyEvents } from './TopologyEvents';

const NO_EVENTS = new Map<string, ResourceItem>();

export function TopologyView({ item, namespace }: { item?: ResourceItem; namespace?: string }) {
  const resources = useResourceStore(useShallow((s) => ({ ...s.resources, Event: NO_EVENTS })));
  const errors = useResourceStore((s) => s.loadErrors);
  const namespaces = useClusterStore((s) => s.availableNamespaces);
  const selectedNamespace = useClusterStore((s) => s.selectedNamespace);
  const snapshotsReady = useClusterStore((s) => s.isConnected && !s.isLoading);
  const [scope, setScope] = useState(() => item?.kind === 'Event' ? item.namespace ? `namespace:${item.namespace}` : '' : item ? 'resource' : namespace ? `namespace:${namespace}` : selectedNamespace !== 'all' ? `namespace:${selectedNamespace}` : '');
  const [depth, setDepth] = useState(2);
  const [direction, setDirection] = useState<'RIGHT' | 'DOWN'>('RIGHT');
  const [revision, setRevision] = useState(0);
  const [scopeQuery, setScopeQuery] = useState('');
  const summaries = useMemo(() => {
    const counts = new Map(namespaces.map((name) => [name, { name, resources: 0, pods: 0 }]));
    for (const map of Object.values(resources)) for (const item of map.values()) {
      const name = item.namespace ?? (item.kind === 'Namespace' ? item.name : undefined);
      if (!name) continue;
      if (!counts.has(name)) counts.set(name, { name, resources: 0, pods: 0 });
      if (item.namespace) counts.get(name)!.resources++;
      if (item.kind === 'Pod') counts.get(name)!.pods++;
    }
    return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [resources, namespaces]);
  const { graph, notice } = useMemo(() => {
    try { return { graph: buildTopology(resources, scope, item, depth), notice: '' }; }
    catch (error) { return { graph: EMPTY_GRAPH, notice: error instanceof Error ? error.message : String(error) }; }
  }, [resources, scope, item, depth]);
  const chooseScope = !scope || scope === 'overview';
  const canLayout = !chooseScope && !notice && graph.items.size > 0;
  const warningCount = useMemo(() => {
    const pods = [...resources.Pod.values()];
    const storageClasses = new Map([...resources.StorageClass.values()].map((entry) => [entry.name, entry]));
    return [...graph.items.values()].filter((resource) => {
      const storageClassName = resource.spec?.storageClassName ?? resource.storageClass;
      return resourceIssues(resource, {
        pods,
        podsLoaded: snapshotsReady && !errors.Pod,
        storageClass: typeof storageClassName === 'string' ? storageClasses.get(storageClassName) : undefined,
      }).length > 0;
    }).length;
  }, [graph, resources.Pod, resources.StorageClass, snapshotsReady, errors.Pod]);

  return <div className="h-full min-h-0 flex flex-col topology-view">
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
      <GitBranch size={14} className="text-[var(--accent)]" /><span className="font-medium">Resource topology</span>
      <SearchableSelect label="Diagram scope" value={scope} onChange={setScope} options={[
        { value: '', label: 'Choose a namespace or resource…' },
        { value: 'overview', label: 'Cluster summary (counts only)' },
        ...summaries.map((summary) => ({ value: `namespace:${summary.name}`, label: `Namespace: ${summary.name} (${summary.resources})` })),
        ...(item && item.kind !== 'Event' ? [{ value: 'resource', label: `${item.kind}: ${item.name}` }] : []),
      ]} />
      {scope === 'resource' && <select aria-label="Relationship depth" className="ide-select" value={depth} onChange={(event) => setDepth(Number(event.target.value))}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n} hop{n > 1 ? 's' : ''}</option>)}</select>}
      <select aria-label="Diagram direction" className="ide-select" value={direction} onChange={(event) => setDirection(event.target.value as 'RIGHT' | 'DOWN')}><option value="RIGHT">Left to right</option><option value="DOWN">Top to bottom</option></select>
      <Button size="sm" disabled={!canLayout} onClick={() => setRevision((value) => value + 1)}><RotateCw size={12} /> Arrange</Button>
      {!chooseScope && !notice && <span className="ml-auto text-[var(--text-muted)] text-[11px]">{graph.items.size} resources · {graph.relations.length} links</span>}
      {warningCount > 0 && <span className="text-[11px] text-[var(--status-warn)] flex items-center gap-1"><TriangleAlert size={12} />{warningCount} with issues</span>}
    </div>
    {!!Object.values(errors).filter(Boolean).length && <div className="px-3 py-1 text-[11px] text-[var(--status-warn)]">Some resource types are unavailable. This diagram shows loaded resources only.</div>}
    <div className="flex-1 min-h-0 relative overflow-hidden">
      {chooseScope ? <div className="h-full overflow-auto p-6">
        <h2 className="text-sm font-medium">Choose a diagram scope</h2>
        <p className="text-xs text-[var(--text-secondary)] mt-2 max-w-xl">Select a namespace below, or open Topology from a Pod, workload or Node. The entire cluster is never expanded automatically.</p>
        <p className="text-[11px] text-[var(--text-muted)] mt-2">Limits: {MAX_TOPOLOGY_NODES} resources, {MAX_TOPOLOGY_EDGES} links and 10 seconds for layout. Cluster summary shows counts only.</p>
        <SearchInput value={scopeQuery} onChange={setScopeQuery} placeholder="Find namespace…" className="mt-4 max-w-sm" />
        <div className="grid gap-2 mt-3 max-w-2xl">{summaries.filter((summary) => summary.name.toLowerCase().includes(scopeQuery.toLowerCase())).slice(0, 50).map((summary) => <button key={summary.name} onClick={() => setScope(`namespace:${summary.name}`)} className="flex items-center gap-3 text-left px-3 py-2 rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] hover:border-[var(--accent)]">
          <span className="font-mono text-xs flex-1 truncate">{summary.name}</span><span className="text-[11px] text-[var(--text-secondary)]">{summary.resources} resources · {summary.pods} Pods</span>
        </button>)}</div>
        {!summaries.length && <p className="text-xs text-[var(--text-muted)] mt-4">No namespaces have been loaded. Open a resource topology from its details.</p>}
      </div> : notice ? <div role="alert" className="p-6 text-[var(--status-warn)] text-xs"><TriangleAlert size={18} className="mb-2" />{notice}<p className="mt-2 text-[var(--text-secondary)]">No graph was sent to the layout worker. Use fewer hops, or open a specific workload or Pod.</p><Button size="sm" className="mt-3" onClick={() => setScope('')}>Choose another scope</Button></div> : <><TopologyCanvas graph={graph} direction={direction} revision={revision} focusKey={item ? resourceKey(item) : undefined} /><TopologyEvents scope={scope} graph={graph} /></>}
    </div>
    <div className="px-3 py-1 border-t border-[var(--border-default)] text-[10px] text-[var(--text-muted)]">Click to inspect · Hover warning icons for reasons · Double-click to focus · Drag to arrange</div>
  </div>;
}
