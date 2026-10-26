import { namespaceScopeLabel, inNamespaceScope } from '../../core/resources/namespace_scope';
import { ArrowRightLeft, Bell, Server, Layers, Terminal, GitBranch } from 'lucide-react';
import { useClusterStore } from '../../state/cluster_store';
import { useResourceStore } from '../../state/resource_store';
import { usePfStore } from '../../state/pf_store';
import { useDockStore } from '../../state/dock_store';
import { useWorkspaceStore } from '../../state/workspace_store';
import { k8s } from '../../providers/k8s_provider';

export function StatusBar() {
  const { currentContext, selectedNamespace, isConnected, clusterVersion, isLoading } = useClusterStore();
  const pods = useResourceStore((s) => s.resources.Pod);
  const syncMode = useResourceStore((s) => s.syncMode);
  const watchStates = useResourceStore((s) => s.watchStates);
  // Cached inventories and intentionally suspended watches are not failures.
  const states = Object.values(watchStates).filter(state => state?.phase !== 'stopped');
  const unavailable = states.filter((state) => state?.phase === 'failed' || state?.phase === 'reconnecting').length;
  const watchLabel = unavailable ? `Watch · ${unavailable} unavailable` : states.length && states.every((state) => state?.phase === 'live') ? 'Watch · live' : 'Watch · synchronizing';
  const pfCount = usePfStore((s) => s.sessions.length);
  const { sessions, focusTool, openPorts, openEvents } = useDockStore();
  return <footer className="app-statusbar h-[calc(26px*var(--ui-factor))] px-3 flex items-center gap-3 border-t border-[var(--border-default)] bg-[var(--bg-secondary)] text-[length:calc(10px*var(--ui-factor))] text-[var(--text-secondary)] shrink-0">
    <span className="status-context flex items-center gap-1.5 min-w-0" title={currentContext ?? ''}><Server size="calc(11px * var(--ui-factor))" className={isConnected ? 'text-[var(--status-ok)]' : 'text-[var(--status-warn)]'} /><span className="truncate font-mono">{currentContext || 'No context'}</span></span>
    <span className="status-namespace flex items-center gap-1"><Layers size="calc(11px * var(--ui-factor))" /><span>{namespaceScopeLabel(selectedNamespace)}</span></span>
    <span className="status-sync hidden lg:inline">{!isConnected ? 'Disconnected' : syncMode === 'watch' ? watchLabel : isLoading ? 'Loading resources…' : k8s.demo ? 'Demo data' : 'Snapshot · use Sync to refresh'}</span>
    <span className="status-pods hidden xl:inline">Pods: {[...pods.values()].filter((p) => p.status === 'Running' && inNamespaceScope(selectedNamespace, p.namespace)).length}/{[...pods.values()].filter((p) => inNamespaceScope(selectedNamespace, p.namespace)).length}</span>
    <div className="flex-1" />
    <button aria-label="Topology" title="Topology" onClick={() => useWorkspaceStore.getState().openTopology()} className="flex items-center gap-1 hover:text-[var(--text-primary)]"><GitBranch size="calc(11px * var(--ui-factor))" /><span className="status-action-label">Topology</span></button>
    <button aria-label="Shells" title="Shells" onClick={() => focusTool('terminal')} className="flex items-center gap-1 hover:text-[var(--text-primary)]"><Terminal size="calc(11px * var(--ui-factor))" /><span className="status-action-label">Shells</span> {sessions.filter((s) => s.type === 'terminal').length}</button>
    <button aria-label="Ports" title="Ports" onClick={openPorts} className="flex items-center gap-1 hover:text-[var(--text-primary)]"><ArrowRightLeft size="calc(11px * var(--ui-factor))" /><span className="status-action-label">Ports</span> {pfCount}</button>
    <button aria-label="Events" title="Events" onClick={openEvents} className="flex items-center gap-1 hover:text-[var(--text-primary)]"><Bell size="calc(11px * var(--ui-factor))" /><span className="status-action-label">Events</span></button>
    {clusterVersion && <span className="status-version font-mono">{clusterVersion.replace(/^v?/, 'v')}</span>}
  </footer>;
}
