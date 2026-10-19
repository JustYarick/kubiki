import React from 'react';
import { useClusterStore } from '../../state/cluster_store';
import { useResourceStore } from '../../state/resource_store';
import { Layers, Search, Server } from 'lucide-react';

export const TitleBar: React.FC = () => {
  const {
    contexts,
    currentContext,
    selectContext,
    selectedNamespace,
    selectNamespace,
    availableNamespaces,
    isConnected,
    clusterVersion,
  } = useClusterStore();

  const { searchQuery, setSearchQuery } = useResourceStore();

  return (
    <header className="h-10 bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between px-3 select-none text-xs text-[var(--text-secondary)] shrink-0 z-20">
      {/* Left: App Title and Cluster Switcher */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
          <span className="w-5 h-5 rounded bg-blue-600 flex items-center justify-center text-white text-[10px] font-black">
            ⎈
          </span>
          <span className="tracking-wide">Kubiki</span>
        </div>

        <div className="h-4 w-px bg-[var(--border-default)]" />

        {/* Cluster Context Picker */}
        <div className="flex items-center gap-1.5">
          <Server className="w-3.5 h-3.5 text-blue-400" />
          <select
            value={currentContext || ''}
            onChange={(e) => selectContext(e.target.value)}
            className="bg-[var(--bg-surface)] text-[var(--text-primary)] border border-[var(--border-default)] rounded px-2 py-0.5 text-xs outline-none focus:border-blue-500 cursor-pointer"
          >
            {contexts.length === 0 ? (
              <option value="">No Contexts</option>
            ) : (
              contexts.map((ctx) => (
                <option key={ctx.name} value={ctx.name}>
                  {ctx.name} {ctx.is_current ? '●' : ''}
                </option>
              ))
            )}
          </select>
        </div>

        {/* Namespace Picker */}
        <div className="flex items-center gap-1.5">
          <Layers className="w-3.5 h-3.5 text-purple-400" />
          <select
            value={selectedNamespace}
            onChange={(e) => selectNamespace(e.target.value)}
            className="bg-[var(--bg-surface)] text-[var(--text-primary)] border border-[var(--border-default)] rounded px-2 py-0.5 text-xs outline-none focus:border-blue-500 cursor-pointer"
          >
            <option value="all">All Namespaces</option>
            {availableNamespaces.map((ns) => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Center: Search input */}
      <div className="relative w-72 max-w-md">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Filter resources (Cmd+P)..."
          className="w-full bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border-default)] rounded pl-8 pr-3 py-1 text-xs outline-none focus:border-blue-500 transition-colors placeholder:text-zinc-500"
        />
      </div>

      {/* Right: Cluster Connection Status */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full ${
              isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-emerald-500'
            }`}
          />
          <span className="font-mono text-[11px] text-[var(--text-muted)]">
            {clusterVersion ? `k8s ${clusterVersion}` : 'Ready'}
          </span>
        </div>
      </div>
    </header>
  );
};
