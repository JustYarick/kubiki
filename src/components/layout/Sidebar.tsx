import React from 'react';
import { useResourceStore } from '../../state/resource_store';
import { ResourceKind } from '../../types/k8s';
import {
  ChevronDown,
  ChevronRight,
  Boxes,
  CircleDot,
  Server,
  Layers,
  FileCode,
  Key,
  Database,
  Network,
  Clock,
  HardDrive,
} from 'lucide-react';

interface NavSection {
  title: string;
  items: { kind: ResourceKind; label: string; icon: React.ReactNode }[];
}

export const Sidebar: React.FC = () => {
  const { activeKind, setActiveKind, resources } = useResourceStore();
  const [openSections, setOpenSections] = React.useState<Record<string, boolean>>({
    Workloads: true,
    Configuration: true,
    Network: true,
    Storage: true,
    Access: true,
  });

  const toggleSection = (title: string) => {
    setOpenSections((prev) => ({ ...prev, [title]: !prev[title] }));
  };

  const sections: NavSection[] = [
    {
      title: 'Workloads',
      items: [
        { kind: 'Pod', label: 'Pods', icon: <CircleDot className="w-4 h-4 text-emerald-400" /> },
        { kind: 'Deployment', label: 'Deployments', icon: <Boxes className="w-4 h-4 text-blue-400" /> },
        { kind: 'StatefulSet', label: 'StatefulSets', icon: <Database className="w-4 h-4 text-indigo-400" /> },
        { kind: 'DaemonSet', label: 'DaemonSets', icon: <Server className="w-4 h-4 text-purple-400" /> },
        { kind: 'Job', label: 'Jobs', icon: <Clock className="w-4 h-4 text-amber-400" /> },
        { kind: 'CronJob', label: 'CronJobs', icon: <Clock className="w-4 h-4 text-cyan-400" /> },
      ],
    },
    {
      title: 'Configuration',
      items: [
        { kind: 'ConfigMap', label: 'ConfigMaps', icon: <FileCode className="w-4 h-4 text-sky-400" /> },
        { kind: 'Secret', label: 'Secrets', icon: <Key className="w-4 h-4 text-amber-400" /> },
      ],
    },
    {
      title: 'Network',
      items: [
        { kind: 'Service', label: 'Services', icon: <Network className="w-4 h-4 text-blue-400" /> },
        { kind: 'Ingress', label: 'Ingresses', icon: <Layers className="w-4 h-4 text-indigo-400" /> },
      ],
    },
    {
      title: 'Storage',
      items: [
        { kind: 'PersistentVolumeClaim', label: 'PVCs', icon: <HardDrive className="w-4 h-4 text-amber-400" /> },
        { kind: 'PersistentVolume', label: 'PVs', icon: <HardDrive className="w-4 h-4 text-zinc-400" /> },
        { kind: 'StorageClass', label: 'StorageClasses', icon: <HardDrive className="w-4 h-4 text-sky-400" /> },
      ],
    },
    {
      title: 'Access Control',
      items: [
        { kind: 'CustomResourceDefinition', label: 'CRDs', icon: <Layers className="w-4 h-4 text-violet-400" /> },
        { kind: 'Namespace', label: 'Namespaces', icon: <Layers className="w-4 h-4 text-emerald-400" /> },
        { kind: 'Node', label: 'Nodes', icon: <Server className="w-4 h-4 text-blue-400" /> },
        { kind: 'Event', label: 'Events', icon: <Clock className="w-4 h-4 text-zinc-400" /> },
      ],
    },
  ];

  return (
    <nav className="w-56 bg-[var(--bg-sidebar)] border-r border-[var(--border-default)] flex flex-col h-full overflow-y-auto select-none py-2 text-xs">
      <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
        Cluster Explorer
      </div>

      <div className="flex flex-col gap-1">
        {sections.map((section) => {
          const isOpen = openSections[section.title] ?? true;
          return (
            <div key={section.title} className="flex flex-col">
              <button
                onClick={() => toggleSection(section.title)}
                className="flex items-center justify-between px-3 py-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] font-medium transition-colors"
              >
                <span className="flex items-center gap-1.5 font-semibold text-[11px]">
                  {isOpen ? (
                    <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
                  )}
                  {section.title}
                </span>
              </button>

              {isOpen && (
                <div className="flex flex-col py-0.5">
                  {section.items.map((item) => {
                    const isSelected = activeKind === item.kind;
                    const count = resources[item.kind]?.size ?? 0;

                    return (
                      <button
                        key={item.kind}
                        onClick={() => setActiveKind(item.kind)}
                        className={`flex items-center justify-between pl-6 pr-3 py-1.5 text-xs transition-colors rounded-none ${
                          isSelected
                            ? 'bg-blue-600/20 text-blue-400 font-medium border-l-2 border-blue-500'
                            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)]'
                        }`}
                      >
                        <span className="flex items-center gap-2 truncate">
                          {item.icon}
                          <span className="truncate">{item.label}</span>
                        </span>
                        {count > 0 && (
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-[var(--bg-surface)] text-[var(--text-muted)]">
                            {count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
};
