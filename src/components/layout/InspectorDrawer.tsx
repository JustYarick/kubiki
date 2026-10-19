import React from 'react';
import { useResourceStore } from '../../state/resource_store';
import { StatusBadge } from '../k8s/StatusBadge';
import { X, Copy, Check } from 'lucide-react';

export const InspectorDrawer: React.FC = () => {
  const { selectedItem, selectItem } = useResourceStore();
  const [activeTab, setActiveTab] = React.useState<'overview' | 'yaml'>('overview');
  const [copied, setCopied] = React.useState(false);

  if (!selectedItem) {
    return null;
  }

  const handleCopyYaml = () => {
    const yaml =
      selectedItem.rawYaml ||
      JSON.stringify(
        {
          apiVersion: selectedItem.apiVersion || 'v1',
          kind: selectedItem.kind,
          metadata: {
            name: selectedItem.name,
            namespace: selectedItem.namespace,
            uid: selectedItem.uid,
          },
        },
        null,
        2
      );
    navigator.clipboard.writeText(yaml);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <aside className="w-80 lg:w-96 bg-[var(--bg-secondary)] border-l border-[var(--border-default)] flex flex-col h-full text-xs select-none shrink-0 z-10">
      {/* Header */}
      <div className="p-3 border-b border-[var(--border-default)] flex items-center justify-between">
        <div className="flex flex-col truncate">
          <span className="text-[10px] uppercase font-bold text-[var(--text-muted)]">
            {selectedItem.kind}
          </span>
          <span className="font-semibold text-sm text-[var(--text-primary)] truncate font-mono">
            {selectedItem.name}
          </span>
        </div>
        <button
          onClick={() => selectItem(null)}
          className="p-1 text-zinc-400 hover:text-white hover:bg-[var(--bg-hover)] rounded transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center px-3 border-b border-[var(--border-default)] bg-[var(--bg-sidebar)]">
        <button
          onClick={() => setActiveTab('overview')}
          className={`py-2 px-3 border-b-2 font-medium text-xs transition-colors ${
            activeTab === 'overview'
              ? 'border-blue-500 text-blue-400'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Overview
        </button>
        <button
          onClick={() => setActiveTab('yaml')}
          className={`py-2 px-3 border-b-2 font-medium text-xs transition-colors ${
            activeTab === 'yaml'
              ? 'border-blue-500 text-blue-400'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          YAML Spec
        </button>
      </div>

      {/* Body Content */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4 font-sans">
        {activeTab === 'overview' ? (
          <>
            <div className="flex flex-col gap-1.5 p-3 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
              <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider font-semibold">
                Status
              </span>
              <div>
                <StatusBadge status={selectedItem.status || 'Active'} />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider font-semibold">
                Metadata
              </span>
              <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                <div className="text-[var(--text-muted)]">Namespace:</div>
                <div className="text-[var(--text-primary)] truncate">
                  {selectedItem.namespace || '-'}
                </div>

                <div className="text-[var(--text-muted)]">Age:</div>
                <div className="text-[var(--text-primary)]">{selectedItem.age || '5m'}</div>

                <div className="text-[var(--text-muted)]">Restarts:</div>
                <div className="text-[var(--text-primary)]">{selectedItem.restarts ?? 0}</div>

                <div className="text-[var(--text-muted)]">UID:</div>
                <div className="text-[var(--text-muted)] truncate text-[10px]">
                  {selectedItem.uid}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-col h-full">
            <div className="flex justify-end pb-2">
              <button
                onClick={handleCopyYaml}
                className="flex items-center gap-1.5 px-2 py-1 bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border border-[var(--border-default)] rounded text-xs text-zinc-300"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="flex-1 p-3 bg-zinc-950 rounded border border-[var(--border-default)] font-mono text-[11px] overflow-auto text-zinc-300">
              {selectedItem.rawYaml ||
                JSON.stringify(
                  {
                    apiVersion: selectedItem.apiVersion || 'v1',
                    kind: selectedItem.kind,
                    metadata: {
                      name: selectedItem.name,
                      namespace: selectedItem.namespace,
                      uid: selectedItem.uid,
                    },
                    status: {
                      phase: selectedItem.status,
                    },
                  },
                  null,
                  2
                )}
            </pre>
          </div>
        )}
      </div>
    </aside>
  );
};
