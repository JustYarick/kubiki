import React, { Suspense, lazy } from 'react';
import { Sidebar } from './Sidebar';
import { Resizer } from './Resizer';
import { uiPixels } from '../../core/appearance';
import { usePanelRegistry } from '../../core/workspace_panels';

const AiConversationsSidebar = lazy(() =>
  import('../../domains/ai/components/AiConversationsSidebar').then((m) => ({
    default: m.AiConversationsSidebar,
  }))
);

export interface PrimarySideBarProps {
  area: string;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  overlaySidebar: boolean;
  logicalViewportWidth: number;
  factor: number;
  onResize: (width: number) => void;
}

export const PrimarySideBar: React.FC<PrimarySideBarProps> = ({
  area,
  sidebarWidth,
  sidebarCollapsed,
  overlaySidebar,
  logicalViewportWidth,
  factor,
  onResize,
}) => {
  const panels = usePanelRegistry((s) => s.panels);
  const areaHasSidebar =
    area === 'explorer' ||
    area === 'ai-agent' ||
    panels.some((p) => p.id === area && p.sidebarComponent);

  const isHidden = sidebarCollapsed || !areaHasSidebar;

  return (
    <>
      <aside
        data-testid="primary-sidebar"
        data-area={area}
        hidden={isHidden}
        style={{ width: uiPixels(Math.min(sidebarWidth, logicalViewportWidth - 56)) }}
        className={`shrink-0 min-h-0 flex flex-col bg-[var(--bg-secondary)] border-r border-[var(--border-default)] select-none z-30 ${
          isHidden ? 'hidden' : ''
        } ${
          overlaySidebar ? 'absolute left-[calc(40px*var(--ui-factor))] top-0 bottom-0 shadow-xl' : ''
        }`}
      >
        {/* Explorer Sidebar: kept mounted in DOM so search filter and expanded trees are preserved */}
        <div
          data-testid="explorer-panel"
          hidden={area !== 'explorer'}
          className={`flex-1 min-h-0 flex flex-col ${area !== 'explorer' ? 'hidden' : ''}`}
        >
          <Sidebar />
        </div>

        {/* AI Agent Conversations Sidebar */}
        <div
          data-testid="ai-conversations-panel"
          hidden={area !== 'ai-agent'}
          className={`flex-1 min-h-0 flex flex-col ${area !== 'ai-agent' ? 'hidden' : ''}`}
        >
          <Suspense fallback={null}>
            <AiConversationsSidebar />
          </Suspense>
        </div>

        {/* Registered panels sidebars */}
        {panels.map((p) => {
          if (!p.sidebarComponent || p.id === 'ai-agent') return null;
          const PanelSidebar = p.sidebarComponent;
          return (
            <div
              key={p.id}
              data-testid={`panel-${p.id}-sidebar`}
              hidden={area !== p.id}
              className={`flex-1 min-h-0 flex flex-col ${area !== p.id ? 'hidden' : ''}`}
            >
              <Suspense fallback={null}>
                <PanelSidebar />
              </Suspense>
            </div>
          );
        })}
      </aside>
      {!isHidden && !overlaySidebar && (
        <Resizer orientation="vertical" onDelta={(d) => onResize(sidebarWidth + d / factor)} />
      )}
    </>
  );
};
