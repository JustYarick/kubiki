import React from 'react';
import {
  Boxes,
  Network,
  Database,
  Sliders,
  Shield,
  Anchor,
  Settings,
  LayoutGrid,
} from 'lucide-react';

export type Perspective =
  | 'cluster'
  | 'workloads'
  | 'network'
  | 'storage'
  | 'config'
  | 'access'
  | 'helm'
  | 'settings';

interface ActivityBarProps {
  activePerspective: Perspective;
  onSelectPerspective: (perspective: Perspective) => void;
}

export const ActivityBar: React.FC<ActivityBarProps> = ({
  activePerspective,
  onSelectPerspective,
}) => {
  const items: { id: Perspective; label: string; icon: React.ReactNode }[] = [
    { id: 'workloads', label: 'Workloads', icon: <Boxes className="w-5 h-5" /> },
    { id: 'network', label: 'Network', icon: <Network className="w-5 h-5" /> },
    { id: 'storage', label: 'Storage', icon: <Database className="w-5 h-5" /> },
    { id: 'config', label: 'Config', icon: <Sliders className="w-5 h-5" /> },
    { id: 'access', label: 'Access Control', icon: <Shield className="w-5 h-5" /> },
    { id: 'helm', label: 'Helm Charts', icon: <Anchor className="w-5 h-5" /> },
    { id: 'cluster', label: 'Cluster', icon: <LayoutGrid className="w-5 h-5" /> },
  ];

  return (
    <aside className="w-12 bg-[var(--bg-secondary)] border-r border-[var(--border-default)] flex flex-col items-center justify-between py-2 shrink-0 select-none">
      <div className="flex flex-col items-center gap-1 w-full">
        {items.map((item) => {
          const isActive = activePerspective === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelectPerspective(item.id)}
              title={item.label}
              className={`w-9 h-9 rounded flex items-center justify-center transition-colors relative ${
                isActive
                  ? 'text-white bg-[var(--bg-surface)]'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-[var(--bg-hover)]'
              }`}
            >
              {isActive && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-blue-500 rounded-r" />
              )}
              {item.icon}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col items-center gap-1 w-full">
        <button
          onClick={() => onSelectPerspective('settings')}
          title="Settings"
          className="w-9 h-9 rounded flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-[var(--bg-hover)] transition-colors"
        >
          <Settings className="w-5 h-5" />
        </button>
      </div>
    </aside>
  );
};
