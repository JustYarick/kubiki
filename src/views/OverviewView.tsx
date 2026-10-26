import './overview.css';
import { namespaceScopeLabel, inNamespaceScope } from '../core/resources/namespace_scope';
import { OverviewProblems } from '../components/k8s/OverviewProblems';
import { PodDistribution } from '../components/k8s/PodDistribution';
import { ResourceTelemetry } from '../components/k8s/ResourceTelemetry';
import { useMemo } from 'react';
import { ArrowRight, Boxes, Layers, Network, Server, Folder, type LucideIcon } from 'lucide-react';
import { useClusterStore } from '../state/cluster_store';
import { useResourceStore } from '../state/resource_store';
import { useWorkspaceStore } from '../state/workspace_store';
import { buildOverview } from '../core/resources/overview';
import type { ResourceKind } from '../types/k8s';
import { k8s } from '../providers/k8s_provider';

export function OverviewView() {
  const { availableResourceKinds, currentContext, selectedNamespace, isLoading, isConnected } = useClusterStore();
  const { resources, syncMode, watchStates, loadErrors } = useResourceStore();
  const summary = useMemo(() => buildOverview({ availableKinds: availableResourceKinds, resources, namespace: selectedNamespace, context: currentContext, syncMode, loading: isLoading, connected: isConnected, watchStates, loadErrors, onDemand: !k8s.demo }), [resources, availableResourceKinds, selectedNamespace, currentContext, syncMode, isLoading, isConnected, watchStates, loadErrors]);
  const open = (kind: ResourceKind) => { useResourceStore.getState().setActiveKind(kind); useWorkspaceStore.getState().openResourceList(kind); };
  const value = (count: number | null | undefined) => count == null ? '—' : count.toLocaleString();
  const pods = summary.row('Pod');
  const nodeCount = summary.row('Node')?.count;
  // Other kinds (especially Events) must not rebuild CPU/RAM budgets and rankings.
  const telemetryPods = useMemo(() => pods?.count == null ? null : [...resources.Pod.values()].filter(pod => inNamespaceScope(selectedNamespace, pod.namespace)), [resources.Pod, pods?.count, selectedNamespace, currentContext]);
  const telemetryNodes = useMemo(() => nodeCount == null ? null : [...resources.Node.values()], [resources.Node, nodeCount, currentContext]);
  if (!currentContext) return <div className="p-6 text-[var(--text-secondary)]">Select a cluster to view its overview.</div>;
  return <div role="region" aria-label={`Overview: ${currentContext}, ${namespaceScopeLabel(selectedNamespace)}`} data-testid="cluster-overview" className="overview-page h-full min-h-0 min-w-0 overflow-auto kubiki-scrollbar select-text">
    {!!summary.incomplete.length && <details className="rounded border border-[var(--status-warn)]/40 p-3 text-xs"><summary className="cursor-pointer text-[var(--status-warn)]">{isLoading ? 'Synchronizing' : 'Partial or stale data'} · {summary.incomplete.length} resource type{summary.incomplete.length === 1 ? '' : 's'}</summary><p className="mt-2 text-[var(--text-secondary)]">Counts include only available snapshots. Unavailable data is shown as —; retained counts may be stale.</p><ul className="mt-2 space-y-1">{summary.incomplete.map(entry => <li key={entry.kind} className="break-words">{entry.kind}: {entry.state}{entry.message ? ` · ${entry.message}` : ''}</li>)}</ul></details>}
    <section aria-label="Summary" className="overview-summary" data-metric-count={selectedNamespace === 'all' ? 5 : 3}>
      <Metric icon={Boxes} label="Pods" value={value(pods?.count)} detail={pods?.count == null ? 'Awaiting Pod data' : `${summary.phases.Running} running · ${summary.phases.Pending} pending`} onClick={() => open('Pod')} />
      <Metric icon={Layers} label="Workload controllers" value={value(summary.workloads)} detail="Deployments, jobs & other controllers" />
      <Metric icon={Network} label="Services" value={value(summary.row('Service')?.count)} detail="In the selected scope" onClick={() => open('Service')} />
      {selectedNamespace === 'all' && <><Metric icon={Server} label="Nodes" value={value(summary.row('Node')?.count)} detail={summary.row('Node')?.count == null ? 'Awaiting Node data' : `${summary.readyNodes} ready`} onClick={() => open('Node')} /><Metric icon={Folder} label="Namespaces" value={value(summary.row('Namespace')?.count)} detail="Loaded namespaces" onClick={() => open('Namespace')} /></>}
    </section>
    <ResourceTelemetry key={`${currentContext}/${selectedNamespace}`} context={currentContext} namespace={selectedNamespace === 'all' ? null : selectedNamespace} pods={telemetryPods} nodes={telemetryNodes}>
      <div className="overview-health-grid">
        <PodDistribution phases={summary.phases} count={pods?.count} />
        <OverviewProblems problems={summary.issues} warningEvents={summary.row('Event')?.count == null ? null : summary.warningEvents} partial={summary.incomplete.length > 0} />
      </div>
    </ResourceTelemetry>
  </div>;
}
function Metric({ icon: Icon, label, value, detail, onClick }: { icon: LucideIcon; label: string; value: string; detail: string; onClick?: () => void }) {
  const Element = onClick ? 'button' : 'div';
  return <Element aria-label={`${label}: ${value}`} title={detail} onClick={onClick} className="overview-summary-item">
    <div className="overview-metric-label"><Icon size={14} aria-hidden="true" /><span>{label}</span>{onClick && <ArrowRight size={12} className="overview-metric-link" aria-hidden="true" />}</div>
    <div className="overview-summary-value">{value}</div><div className="overview-metric-detail">{detail}</div>
  </Element>;
}
