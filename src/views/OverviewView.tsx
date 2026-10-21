import './overview.css';
import { OverviewSection } from '../components/k8s/OverviewSection';
import { namespaceScopeLabel } from '../core/resources/namespace_scope';
import { inNamespaceScope } from '../core/resources/namespace_scope';
import { OverviewProblems } from '../components/k8s/OverviewProblems';
import { ResourceTelemetry } from '../components/k8s/ResourceTelemetry';
import { useMemo } from 'react';
import { LayoutDashboard, ArrowRight } from 'lucide-react';
import { useClusterStore } from '../state/cluster_store';
import { useResourceStore } from '../state/resource_store';
import { useWorkspaceStore } from '../state/workspace_store';
import { buildOverview } from '../core/resources/overview';
import { ResourceKindBadge } from '../components/k8s/ResourceKindBadge';
import type { ResourceKind } from '../types/k8s';

const phaseColors: Record<string, string> = { Running: 'var(--status-ok)', Pending: 'var(--status-pending)', Succeeded: 'var(--text-muted)', Failed: 'var(--status-danger)', Terminating: 'var(--status-warn)', Unknown: 'var(--text-muted)' };
export function OverviewView() {
  const { availableResourceKinds, currentContext, selectedNamespace, isLoading, isConnected, clusterVersion } = useClusterStore();
  const { resources, syncMode, watchStates, loadErrors } = useResourceStore();
  const summary = useMemo(() => buildOverview({ availableKinds: availableResourceKinds, resources, namespace: selectedNamespace, context: currentContext, syncMode, loading: isLoading, connected: isConnected, watchStates, loadErrors }), [resources, availableResourceKinds, selectedNamespace, currentContext, syncMode, isLoading, isConnected, watchStates, loadErrors]);
  const open = (kind: ResourceKind) => { useResourceStore.getState().setActiveKind(kind); useWorkspaceStore.getState().openResourceList(kind); };
  const value = (count: number | null | undefined) => count == null ? '—' : count.toLocaleString();
  const pods = summary.row('Pod');
  const nodeCount = summary.row('Node')?.count;
  // Other kinds (especially Events) must not rebuild CPU/RAM budgets and rankings.
  const telemetryPods = useMemo(() => pods?.count == null ? null : [...resources.Pod.values()].filter(pod => inNamespaceScope(selectedNamespace, pod.namespace)), [resources.Pod, pods?.count, selectedNamespace, currentContext]);
  const telemetryNodes = useMemo(() => nodeCount == null ? null : [...resources.Node.values()], [resources.Node, nodeCount, currentContext]);
  if (!currentContext) return <div className="p-6 text-[var(--text-secondary)]">Select a cluster to view its overview.</div>;
  return <div data-testid="cluster-overview" className="overview-page h-full min-h-0 min-w-0 overflow-auto kubiki-scrollbar select-text">
    <header className="overview-page-header"><LayoutDashboard size={22} className="text-[var(--accent)] shrink-0 mt-1" /><div className="min-w-0 flex-1"><h1 className="text-lg font-semibold">{selectedNamespace === 'all' ? 'Cluster overview' : 'Namespace overview'}</h1><p className="overview-context">{currentContext} · {namespaceScopeLabel(selectedNamespace)}{clusterVersion ? ` · ${clusterVersion}` : ''}</p></div><span className="text-xs text-[var(--text-muted)]">{syncMode === 'demo' ? 'Demo data' : syncMode === 'watch' ? 'Live watch' : 'Snapshot'} · {isConnected ? 'Connected' : 'Disconnected'}</span></header>
    {!!summary.incomplete.length && <details className="rounded border border-[var(--status-warn)]/40 p-3 text-xs"><summary className="cursor-pointer text-[var(--status-warn)]">{isLoading ? 'Synchronizing' : 'Partial or stale data'} · {summary.incomplete.length} resource type{summary.incomplete.length === 1 ? '' : 's'}</summary><p className="mt-2 text-[var(--text-secondary)]">Counts include only available snapshots. Unavailable data is shown as —; retained counts may be stale.</p><ul className="mt-2 space-y-1">{summary.incomplete.map(entry => <li key={entry.kind} className="break-words">{entry.kind}: {entry.state}{entry.message ? ` · ${entry.message}` : ''}</li>)}</ul></details>}
    <section aria-label="Summary" className="overview-summary" data-metric-count={selectedNamespace === 'all' ? 6 : 4}>
      <Metric label="Pods" value={value(pods?.count)} detail={pods?.count == null ? 'Awaiting Pod data' : `${summary.phases.Running} running · ${summary.phases.Pending} pending`} onClick={() => open('Pod')} />
      <Metric label="Workload controllers" value={value(summary.workloads)} detail="Deployments, StatefulSets, DaemonSets, Jobs, CronJobs" />
      <Metric label="Services" value={value(summary.row('Service')?.count)} detail="Services in this scope" onClick={() => open('Service')} />
      <Metric label="Container restarts" value={value(summary.restarts)} detail="Cumulative across loaded Pods" onClick={() => open('Pod')} />
      {selectedNamespace === 'all' && <><Metric label="Nodes" value={value(summary.row('Node')?.count)} detail={summary.row('Node')?.count == null ? 'Awaiting Node data' : `${summary.readyNodes} ready`} onClick={() => open('Node')} /><Metric label="Namespaces" value={value(summary.row('Namespace')?.count)} detail="Loaded namespaces" onClick={() => open('Namespace')} /></>}
    </section>
    <OverviewProblems problems={summary.issues} warningEvents={summary.row('Event')?.count === null ? null : summary.warningEvents} partial={summary.incomplete.length > 0} />
    <OverviewSection label="Pod phases" title="Pod phases">
      {pods?.count == null ? <p className="overview-muted">Pod data unavailable or synchronizing.</p> : <>
        <div className="overview-phase-track" aria-hidden="true">{Object.entries(summary.phases).map(([phase, count]) => count > 0 && <div key={phase} style={{ width: `${count / (pods?.count || 1) * 100}%`, background: phaseColors[phase] }} />)}</div>
        <dl className="overview-phases">{Object.entries(summary.phases).map(([phase, count]) => <div key={phase}><span className="overview-phase-dot" style={{ background: phaseColors[phase] }} /><dt>{phase}</dt><dd>{count}</dd></div>)}</dl>
      </>}
    </OverviewSection>
    <ResourceTelemetry key={`${currentContext}/${selectedNamespace}`} context={currentContext} namespace={selectedNamespace === 'all' ? null : selectedNamespace} pods={telemetryPods} nodes={telemetryNodes} />
    <OverviewSection label="Resource inventory" title={<>Resource inventory <span className="overview-muted">· {summary.total.toLocaleString()} objects</span></>} description="Built-in resources in the selected scope. Events are listed separately."><div className="overview-inventory">{summary.inventory.map(entry => <button key={entry.kind} aria-label={`Open ${entry.kind} resources`} className="overview-inventory-item" onClick={() => open(entry.kind)}><span className="flex-1 min-w-0"><ResourceKindBadge kind={entry.kind} />{entry.state !== 'ready' && <span className="block mt-1 text-[var(--status-warn)] text-xs">{entry.state}</span>}</span><span className="font-mono text-sm" data-testid={`overview-count-${entry.kind}`}>{value(entry.count)}</span><ArrowRight size={12} className="text-[var(--text-muted)]" /></button>)}</div></OverviewSection>
  </div>;
}
function Metric({ label, value, detail, onClick }: { label: string; value: string; detail: string; onClick?: () => void }) {
  const Element = onClick ? 'button' : 'div';
  return <Element aria-label={`${label}: ${value}`} title={detail} onClick={onClick} className="overview-summary-item"><div className="text-xs text-[var(--text-secondary)]">{label}</div><div className="overview-summary-value">{value}</div>{(label === 'Pods' || label === 'Nodes') && <div className="text-xs text-[var(--text-muted)]" title={detail}>{detail}</div>}</Element>;
}
