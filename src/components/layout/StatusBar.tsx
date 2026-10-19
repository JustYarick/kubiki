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
  const pfCount = usePfStore((s) => s.sessions.length);
  const { sessions, focusTool, openPorts, openEvents } = useDockStore();
  return <footer className="h-[26px] px-3 flex items-center gap-3 border-t border-[var(--border-default)] bg-[var(--bg-secondary)] text-[10px] text-[var(--text-secondary)] shrink-0">
    <span className="flex items-center gap-1.5 min-w-0" title={currentContext ?? ''}><Server size={11} className={isConnected ? 'text-[var(--status-ok)]' : 'text-[var(--status-warn)]'} /><span className="truncate font-mono">{currentContext || 'No context'}</span></span>
    <span className="flex items-center gap-1"><Layers size={11} />{selectedNamespace === 'all' ? 'All namespaces' : selectedNamespace}</span>
    <span className="hidden lg:inline">{isLoading ? 'Loading resources…' : k8s.demo ? 'Demo data' : isConnected ? 'Snapshot · use Sync to refresh' : 'Disconnected'}</span>
    <span className="hidden xl:inline">Pods: {[...pods.values()].filter((p) => p.status === 'Running').length}/{pods.size}</span>
    <div className="flex-1" />
    <button onClick={() => useWorkspaceStore.getState().openTopology(undefined, selectedNamespace === 'all' ? undefined : selectedNamespace)} className="flex items-center gap-1 hover:text-[var(--text-primary)]"><GitBranch size={11} />Topology</button>
    <button onClick={() => focusTool('terminal')} className="flex items-center gap-1 hover:text-[var(--text-primary)]"><Terminal size={11} />Shells {sessions.filter((s) => s.type === 'terminal').length}</button>
    <button onClick={openPorts} className="flex items-center gap-1 hover:text-[var(--text-primary)]"><ArrowRightLeft size={11} />Ports {pfCount}</button>
    <button onClick={openEvents} className="flex items-center gap-1 hover:text-[var(--text-primary)]"><Bell size={11} />Events</button>
    {clusterVersion && <span className="font-mono">{clusterVersion.replace(/^v?/, 'v')}</span>}
  </footer>;
}
