import React from 'react';
import { Terminal, FileText, ArrowRightLeft, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';

export type DockTab = 'terminal' | 'logs' | 'ports' | 'events';

interface BottomDockProps {
  activeTab: DockTab;
  onSelectTab: (tab: DockTab) => void;
  isOpen: boolean;
  onToggleOpen: () => void;
  podNameForLogs?: string;
  podNameForTerminal?: string;
}

export const BottomDock: React.FC<BottomDockProps> = ({
  activeTab,
  onSelectTab,
  isOpen,
  onToggleOpen,
  podNameForLogs,
  podNameForTerminal,
}) => {
  if (!isOpen) {
    return (
      <div className="h-7 bg-[var(--bg-secondary)] border-t border-[var(--border-default)] flex items-center justify-between px-3 text-xs select-none">
        <div className="flex items-center gap-4">
          <button
            onClick={() => {
              onSelectTab('terminal');
              onToggleOpen();
            }}
            className="flex items-center gap-1.5 text-zinc-400 hover:text-white transition-colors"
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>Terminal</span>
          </button>
          <button
            onClick={() => {
              onSelectTab('logs');
              onToggleOpen();
            }}
            className="flex items-center gap-1.5 text-zinc-400 hover:text-white transition-colors"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Logs</span>
          </button>
          <button
            onClick={() => {
              onSelectTab('ports');
              onToggleOpen();
            }}
            className="flex items-center gap-1.5 text-zinc-400 hover:text-white transition-colors"
          >
            <ArrowRightLeft className="w-3.5 h-3.5" />
            <span>Port Forwarding</span>
          </button>
        </div>
        <button
          onClick={onToggleOpen}
          className="text-zinc-400 hover:text-white p-0.5 rounded"
          title="Expand Dock"
        >
          <ChevronUp className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="h-64 bg-[var(--bg-secondary)] border-t border-[var(--border-default)] flex flex-col select-none shrink-0 z-10">
      {/* Dock Header Tabs */}
      <div className="h-8 bg-[var(--bg-sidebar)] border-b border-[var(--border-default)] flex items-center justify-between px-2">
        <div className="flex items-center gap-1 h-full">
          <button
            onClick={() => onSelectTab('terminal')}
            className={`flex items-center gap-1.5 px-3 h-full border-b-2 text-xs font-medium transition-colors ${
              activeTab === 'terminal'
                ? 'border-blue-500 text-blue-400 bg-[var(--bg-secondary)]'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>Terminal {podNameForTerminal ? `(${podNameForTerminal})` : ''}</span>
          </button>

          <button
            onClick={() => onSelectTab('logs')}
            className={`flex items-center gap-1.5 px-3 h-full border-b-2 text-xs font-medium transition-colors ${
              activeTab === 'logs'
                ? 'border-blue-500 text-blue-400 bg-[var(--bg-secondary)]'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Logs {podNameForLogs ? `(${podNameForLogs})` : ''}</span>
          </button>

          <button
            onClick={() => onSelectTab('ports')}
            className={`flex items-center gap-1.5 px-3 h-full border-b-2 text-xs font-medium transition-colors ${
              activeTab === 'ports'
                ? 'border-blue-500 text-blue-400 bg-[var(--bg-secondary)]'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <ArrowRightLeft className="w-3.5 h-3.5" />
            <span>Port Forwarding</span>
          </button>

          <button
            onClick={() => onSelectTab('events')}
            className={`flex items-center gap-1.5 px-3 h-full border-b-2 text-xs font-medium transition-colors ${
              activeTab === 'events'
                ? 'border-blue-500 text-blue-400 bg-[var(--bg-secondary)]'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <AlertCircle className="w-3.5 h-3.5" />
            <span>Cluster Events</span>
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={onToggleOpen}
            className="p-1 text-zinc-400 hover:text-white hover:bg-[var(--bg-hover)] rounded transition-colors"
            title="Collapse Dock"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Dock Content */}
      <div className="flex-1 bg-zinc-950 p-2 font-mono text-xs overflow-auto text-zinc-300">
        {activeTab === 'terminal' && (
          <div className="h-full flex flex-col justify-center items-center text-zinc-500">
            <p>PTY Interactive Shell Session</p>
            <p className="text-[11px] mt-1 text-zinc-600">
              {podNameForTerminal
                ? `Connected to container in ${podNameForTerminal}`
                : 'Select a pod and click "Open Shell" to connect'}
            </p>
          </div>
        )}

        {activeTab === 'logs' && (
          <div className="h-full flex flex-col">
            <div className="flex items-center justify-between pb-1 border-b border-zinc-800 text-[11px] text-zinc-500">
              <span>Streaming logs: {podNameForLogs || 'No pod selected'}</span>
              <span>Auto-scroll: ON</span>
            </div>
            <div className="flex-1 overflow-auto pt-2 space-y-0.5">
              <p className="text-zinc-500">2026-10-19T14:50:01.120Z [INFO] Service initialized</p>
              <p className="text-zinc-400">2026-10-19T14:50:02.341Z [INFO] Listening on 0.0.0.0:8080</p>
              <p className="text-emerald-400">2026-10-19T14:50:05.890Z [INFO] Health probe HTTP 200 OK</p>
            </div>
          </div>
        )}

        {activeTab === 'ports' && (
          <div className="h-full flex flex-col justify-center items-center text-zinc-500">
            <p>No active port-forward sessions</p>
            <p className="text-[11px] mt-1 text-zinc-600">
              Click the port forward icon on any Pod or Service to tunnel traffic
            </p>
          </div>
        )}

        {activeTab === 'events' && (
          <div className="h-full flex flex-col space-y-1">
            <p className="text-zinc-400">
              <span className="text-zinc-600 font-bold">1m ago:</span> Pulled image "nginx:latest" successfully
            </p>
            <p className="text-emerald-400">
              <span className="text-zinc-600 font-bold">1m ago:</span> Created container web-server
            </p>
            <p className="text-emerald-400">
              <span className="text-zinc-600 font-bold">1m ago:</span> Started container web-server
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
