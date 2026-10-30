import React, { Suspense } from 'react';
import { InspectorPanel } from './InspectorPanel';
import { Resizer } from './Resizer';
import { uiPixels } from '../../core/appearance';
import { usePanelRegistry } from '../../core/workspace_panels';
import { areaHasInspector } from '../../core/workspace_areas';

export interface SecondarySideBarProps {
  area: string;
  inspectorWidth: number;
  inspectorCollapsed: boolean;
  headerHeight: number;
  factor: number;
  logicalViewportWidth: number;
  onResize: (width: number) => void;
}

export const SecondarySideBar: React.FC<SecondarySideBarProps> = ({
  area,
  inspectorWidth,
  inspectorCollapsed,
  headerHeight,
  factor,
  logicalViewportWidth,
  onResize,
}) => {
  const panels = usePanelRegistry((s) => s.panels);
  const panel = panels.find((p) => p.id === area);

  // Check if there is an active component for the secondary sidebar
  const hasInspector = areaHasInspector(area);
  const hasCustomSecondary = !!panel?.secondarySidebarComponent;

  if ((!hasInspector && !hasCustomSecondary) || inspectorCollapsed) {
    return null;
  }

  const detailWidth = Math.min(inspectorWidth, Math.max(0, logicalViewportWidth - 56 / factor));

  let content: React.ReactNode = null;
  if (panel?.secondarySidebarComponent) {
    const CustomSecondary = panel.secondarySidebarComponent;
    content = (
      <Suspense fallback={null}>
        <CustomSecondary />
      </Suspense>
    );
  } else if (hasInspector) {
    content = <InspectorPanel />;
  }

  return (
    <aside
      data-testid="inspector-panel"
      data-layout="overlay"
      style={{
        width: uiPixels(detailWidth),
        top: uiPixels(headerHeight),
      }}
      className="absolute right-0 bottom-0 z-40 min-h-0 border-l border-[var(--border-default)] shadow-xl bg-[var(--bg-canvas)] flex flex-col"
    >
      <Resizer
        orientation="vertical"
        style={{ position: 'absolute', left: 0, top: 0, bottom: 0, zIndex: 10 }}
        onDelta={(d) => onResize(inspectorWidth - d / factor)}
      />
      <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
        {content}
      </div>
    </aside>
  );
};
