import React from 'react';
import {
  ArrowRightLeft,
  Bell,
  Server,
  Layers,
  Terminal,
  Cpu,
  HardDrive,
  Zap,
} from 'lucide-react';
import { useClusterStore } from '../../state/cluster_store';
import { useResourceStore } from '../../state/resource_store';
import { usePfStore } from '../../state/pf_store';
import { useUiStore } from '../../state/ui_store';
import { cx } from '../../core/utils/cx';

export const StatusBar: React.FC = () => {
  const { currentContext, selectedNamespace, isConnected, clusterVersion } = useClusterStore();
  const { resources } = useResourceStore();
  const pfCount = usePfStore((s) => s.sessions.length);
  const { activeDockTab, openDock, dockCollapsed } = useUiStore();

  const podMap = resources['Pod'];
  const totalPods = podMap?.size || 0;
  const runningPods = Array.from(podMap?.values() || []).filter((p) => p.status === 'Running').length;

  return (
    <footer className="h-[25px] bg-[var(--bg-secondary)] border-t border-[var(--border-default)] flex items-center justify-between px-2.5 select-none text-[11px] shrink-0 font-sans text-[var(--text-secondary)] z-30">
      {/* Left Telemetry */}
      <div className="flex items-center gap-2.5 min-w-0">
        {/* Cluster Status */}
        <span
          className="flex items-center gap-1.5 font-mono text-[11px] truncate cursor-pointer hover:text-[var(--text-primary)]"
          title={`Context: ${currentContext || 'none'}`}
        >
          <Server size={11} className={isConnected ? 'text-[var(--status-ok)]' : 'text-[var(--status-warn)]'} />
          <span className="truncate">{currentContext ?? 'no-context'}</span>
        </span>

        {/* Namespace */}
        <span className="flex items-center gap-1 font-mono text-[11px] text-[var(--text-muted)]" title="Active namespace filter">
          <Layers size={11} className="text-violet-400" />
          <span>{selectedNamespace === 'all' ? 'all-namespaces' : selectedNamespace}</span>
        </span>

        <div className="h-3 w-px bg-[var(--border-default)]" />

        {/* Pods Healthy Ratio */}
        <span className="hidden md:flex items-center gap-1 text-[var(--text-muted)] font-mono text-[10.5px]">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--status-ok)]" />
          Pods: {runningPods}/{totalPods}
        </span>

        {/* Informer Stream Status */}
        <span className="hidden lg:flex items-center gap-1 text-[var(--text-muted)] font-mono text-[10.5px]">
          <Zap size={11} className="text-amber-400" />
          <span>Watch sync active</span>
        </span>
      </div>

      {/* Right Telemetry & Quick Tool Window Triggers */}
      <div className="flex items-center gap-1 shrink-0 font-mono text-[10.5px]">
        {/* Mock CPU / RAM telemetry sparkline pills */}
        <div className="hidden sm:flex items-center gap-2 px-1.5 py-0.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--text-muted)] mr-1">
          <span className="flex items-center gap-1" title="Cluster CPU Usage">
            <Cpu size={10} className="text-blue-400" />
            <span>24%</span>
          </span>
          <span className="text-[var(--border-default)]">|</span>
          <span className="flex items-center gap-1" title="Cluster Memory Usage">
            <HardDrive size={10} className="text-emerald-400" />
            <span>52%</span>
          </span>
        </div>

        {/* Shell Sessions Trigger */}
        <button
          onClick={() => openDock('terminal')}
          className={cx(
            'flex items-center gap-1 px-1.5 h-[20px] rounded-[3px] transition-colors',
            activeDockTab === 'terminal' && !dockCollapsed
              ? 'bg-[var(--bg-surface)] text-[var(--text-primary)]'
              : 'hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]'
          )}
          title="Open Pod Shells (⌘J)"
        >
          <Terminal size={11} className="text-emerald-400" />
          <span>shell: 1</span>
        </button>

        {/* Port Forwards Trigger */}
        <button
          onClick={() => openDock('ports')}
          className={cx(
            'flex items-center gap-1 px-1.5 h-[20px] rounded-[3px] transition-colors',
            pfCount > 0 && 'text-[var(--status-ok)] font-medium',
            activeDockTab === 'ports' && !dockCollapsed
              ? 'bg-[var(--bg-surface)] text-[var(--text-primary)]'
              : 'hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]'
          )}
          title="Active Port Forwards"
        >
          <ArrowRightLeft size={11} />
          <span>pf: {pfCount}</span>
        </button>

        {/* Events Trigger */}
        <button
          onClick={() => openDock('events')}
          className={cx(
            'flex items-center gap-1 px-1.5 h-[20px] rounded-[3px] transition-colors',
            activeDockTab === 'events' && !dockCollapsed
              ? 'bg-[var(--bg-surface)] text-[var(--text-primary)]'
              : 'hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]'
          )}
          title="Cluster Event Stream"
        >
          <Bell size={11} />
          <span>events</span>
        </button>

        <div className="h-3 w-px bg-[var(--border-default)] mx-0.5" />

        <span className="text-[var(--text-muted)] text-[10px]">
          {clusterVersion ? `k8s v${clusterVersion}` : 'k8s'}
        </span>
      </div>
    </footer>
  );
};
