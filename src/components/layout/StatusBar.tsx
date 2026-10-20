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
  const states = Object.values(watchStates);
  const unavailable = states.filter((state) => state.phase === 'failed' || state.phase === 'reconnecting' || state.phase === 'stopped').length;
  const watchLabel = unavailable ? `Watch · ${unavailable} unavailable` : states.length && states.every((state) => state.phase === 'live') ? 'Watch · live' : 'Watch · synchronizing';
  const pfCount = usePfStore((s) => s.sessions.length);
  const { sessions, focusTool, openPorts, openEvents } = useDockStore();
  return <footer className="h-[calc(26px*var(--ui-factor))] px-3 flex items-center gap-3 border-t border-[var(--border-default)] bg-[var(--bg-secondary)] text-[length:calc(10px*var(--ui-factor))] text-[var(--text-secondary)] shrink-0">
    <span className="flex items-center gap-1.5 min-w-0" title={currentContext ?? ''}><Server size="calc(11px * var(--ui-factor))" className={isConnected ? 'text-[var(--status-ok)]' : 'text-[var(--status-warn)]'} /><span className="truncate font-mono">{currentContext || 'No context'}</span></span>
    <span className="flex items-center gap-1"><Layers size="calc(11px * var(--ui-factor))" />{selectedNamespace === 'all' ? 'All namespaces' : selectedNamespace}</span>
    <span className="hidden lg:inline">{!isConnected ? 'Disconnected' : syncMode === 'watch' ? watchLabel : isLoading ? 'Loading resources…' : k8s.demo ? 'Demo data' : 'Snapshot · use Sync to refresh'}</span>
    <span className="hidden xl:inline">Pods: {[...pods.values()].filter((p) => p.status === 'Running').length}/{pods.size}</span>
    <div className="flex-1" />
    <button onClick={() => useWorkspaceStore.getState().openTopology(undefined, selectedNamespace === 'all' ? undefined : selectedNamespace)} className="flex items-center gap-1 hover:text-[var(--text-primary)]"><GitBranch size="calc(11px * var(--ui-factor))" />Topology</button>
    <button onClick={() => focusTool('terminal')} className="flex items-center gap-1 hover:text-[var(--text-primary)]"><Terminal size="calc(11px * var(--ui-factor))" />Shells {sessions.filter((s) => s.type === 'terminal').length}</button>
    <button onClick={openPorts} className="flex items-center gap-1 hover:text-[var(--text-primary)]"><ArrowRightLeft size="calc(11px * var(--ui-factor))" />Ports {pfCount}</button>
    <button onClick={openEvents} className="flex items-center gap-1 hover:text-[var(--text-primary)]"><Bell size="calc(11px * var(--ui-factor))" />Events</button>
    {clusterVersion && <span className="font-mono">{clusterVersion.replace(/^v?/, 'v')}</span>}
  </footer>;
}
