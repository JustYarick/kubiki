import React, { useState, lazy, Suspense } from 'react';
import { MainTabBar } from './MainTabBar';
import { BreadcrumbBar } from './BreadcrumbBar';
import { ResourceView } from '../../views/ResourceView';
import { useWorkspaceStore, type WorkspaceTab } from '../../state/workspace_store';
import { useResourceStore } from '../../state/resource_store';
import { Resizer } from './Resizer';
import { toast } from '../../state/notifications_store';
import { FileCode, Loader2 } from 'lucide-react';

const YamlEditor = lazy(() => import('../../views/YamlEditor').then((m) => ({ default: m.YamlEditor })));

export const WorkspaceArea: React.FC = () => {
  const { tabs, activeTabId, splitTabId } = useWorkspaceStore();
  const [splitRatio, setSplitRatio] = useState(0.5); // 50% split by default

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  const splitTab = splitTabId ? tabs.find((t) => t.id === splitTabId) : null;

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-[var(--bg-canvas)] overflow-hidden">
      {/* Top JetBrains Tab Bar */}
      <MainTabBar />

      {/* JetBrains Interactive Breadcrumb Bar */}
      <BreadcrumbBar />

      {/* Main Content Area: Single Pane or Split Panes */}
      <div className="flex-1 min-h-0 min-w-0 relative flex overflow-hidden">
        {splitTab ? (
          <div className="flex-1 flex min-h-0 min-w-0">
            {/* Primary Left Pane */}
            <div
              style={{ flex: `${splitRatio} 1 0%` }}
              className="min-w-[300px] min-h-0 flex flex-col border-r border-[var(--border-default)]"
            >
              <TabContent tab={activeTab} />
            </div>

            {/* Split Resizer */}
            <Resizer
              orientation="vertical"
              onDelta={(d) => {
                setSplitRatio((prev) => {
                  const deltaFrac = d / (window.innerWidth * 0.6);
                  return Math.min(0.8, Math.max(0.2, prev + deltaFrac));
                });
              }}
            />

            {/* Secondary Right Pane */}
            <div
              style={{ flex: `${1 - splitRatio} 1 0%` }}
              className="min-w-[300px] min-h-0 flex flex-col"
            >
              <div className="h-6 px-2.5 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)] flex items-center justify-between text-[11px] text-[var(--text-muted)] select-none">
                <span className="font-medium text-[var(--text-secondary)]">{splitTab.title}</span>
                <span className="text-[10px] uppercase font-mono">Split View</span>
              </div>
              <TabContent tab={splitTab} />
            </div>
          </div>
        ) : (
          /* Single Full Pane */
          <div className="flex-1 min-h-0 min-w-0 flex flex-col">
            <TabContent tab={activeTab} />
          </div>
        )}
      </div>
    </div>
  );
};

function TabContent({ tab }: { tab?: WorkspaceTab }) {
  const { resources, updateItem } = useResourceStore();

  if (!tab) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">
        No active tab
      </div>
    );
  }

  if (tab.type === 'yaml-editor') {
    // Find current item from resource store or fallback to tab.item
    const kind = tab.kind || 'Pod';
    const item =
      (tab.uid ? resources[kind]?.get(tab.uid) : null) ||
      (tab.name ? Array.from(resources[kind]?.values() || []).find((i) => i.name === tab.name) : null) ||
      tab.item;

    if (!item) {
      return (
        <div className="flex-1 flex items-center justify-center p-6 text-center">
          <div>
            <FileCode size={36} className="mx-auto text-[var(--text-muted)] mb-2" />
            <div className="text-sm font-medium text-[var(--text-primary)]">Resource Not Found</div>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              {tab.title} was deleted or is not currently available.
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="flex-1 min-h-0 min-w-0">
        <Suspense
          fallback={
            <div className="h-full flex items-center justify-center gap-2 text-[11px] text-[var(--text-muted)]">
              <Loader2 size={14} className="animate-spin" />
              Loading editor…
            </div>
          }
        >
          <YamlEditor
            item={item}
            onApply={(yaml) => {
              updateItem(item.kind, item.uid, { rawYaml: yaml });
              toast.success('Manifest Applied', `${item.kind}/${item.name}`);
            }}
          />
        </Suspense>
      </div>
    );
  }

  // Default: Resource List Table
  return <ResourceView explicitKind={tab.kind} />;
}
