import React from 'react';
import { useResourceStore } from '../../state/resource_store';
import { StatusBadge } from './StatusBadge';
import { ResourceItem } from '../../types/k8s';
import { Terminal, FileText, ArrowRightLeft } from 'lucide-react';

interface ResourceTableProps {
  onOpenLogs?: (item: ResourceItem) => void;
  onOpenShell?: (item: ResourceItem) => void;
  onOpenPortForward?: (item: ResourceItem) => void;
}

export const ResourceTable: React.FC<ResourceTableProps> = ({
  onOpenLogs,
  onOpenShell,
  onOpenPortForward,
}) => {
  const { activeKind, getActiveResources, selectedItem, selectItem } = useResourceStore();
  const items = getActiveResources();

  if (items.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 text-xs p-8 select-none">
        <p className="font-medium text-sm text-zinc-400">No {activeKind} resources found</p>
        <p className="mt-1">Change namespace filter or verify cluster connectivity.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-[var(--bg-primary)]">
      <table className="w-full text-left border-collapse text-xs font-sans">
        <thead className="bg-[var(--bg-secondary)] sticky top-0 z-10 border-b border-[var(--border-default)] select-none">
          <tr className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            <th className="py-2 px-3">Name</th>
            <th className="py-2 px-3">Namespace</th>
            <th className="py-2 px-3">Status</th>
            <th className="py-2 px-3">Ready</th>
            <th className="py-2 px-3">Restarts</th>
            <th className="py-2 px-3">Age</th>
            <th className="py-2 px-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border-subtle)] font-mono">
          {items.map((item) => {
            const isSelected = selectedItem?.uid === item.uid;
            return (
              <tr
                key={item.uid}
                onClick={() => selectItem(item)}
                className={`transition-colors cursor-pointer group ${
                  isSelected
                    ? 'bg-blue-600/15 text-white'
                    : 'hover:bg-[var(--bg-surface)] text-[var(--text-primary)]'
                }`}
              >
                <td className="py-2 px-3 font-semibold text-blue-400 group-hover:underline flex items-center gap-2">
                  <span className="truncate max-w-xs">{item.name}</span>
                </td>
                <td className="py-2 px-3 text-[var(--text-secondary)]">{item.namespace || '-'}</td>
                <td className="py-2 px-3">
                  <StatusBadge status={item.status || 'Active'} />
                </td>
                <td className="py-2 px-3 text-[var(--text-secondary)]">{item.ready || '1/1'}</td>
                <td className="py-2 px-3 text-[var(--text-secondary)]">{item.restarts ?? 0}</td>
                <td className="py-2 px-3 text-[var(--text-muted)] text-[11px]">{item.age || '5m'}</td>
                <td className="py-2 px-3 text-right">
                  <div className="flex items-center justify-end gap-1 opacity-80 group-hover:opacity-100">
                    {activeKind === 'Pod' && (
                      <>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenShell?.(item);
                          }}
                          title="Open Shell"
                          className="p-1 hover:bg-[var(--bg-hover)] text-zinc-400 hover:text-white rounded"
                        >
                          <Terminal className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenLogs?.(item);
                          }}
                          title="View Logs"
                          className="p-1 hover:bg-[var(--bg-hover)] text-zinc-400 hover:text-white rounded"
                        >
                          <FileText className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenPortForward?.(item);
                          }}
                          title="Port Forward"
                          className="p-1 hover:bg-[var(--bg-hover)] text-zinc-400 hover:text-white rounded"
                        >
                          <ArrowRightLeft className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
