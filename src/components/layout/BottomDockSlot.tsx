import React, { Suspense } from 'react';
import { BottomDock } from './BottomDock';
import { Resizer } from './Resizer';
import { uiPixels } from '../../core/appearance';
import { usePanelRegistry } from '../../core/workspace_panels';
import { useDockStore } from '../../state/dock_store';

export interface BottomDockSlotProps {
  area: string;
  factor: number;
  showInspector: boolean;
  detailWidth: number;
}

export const BottomDockSlot: React.FC<BottomDockSlotProps> = ({
  area,
  factor,
  showInspector,
  detailWidth,
}) => {
  const panels = usePanelRegistry((s) => s.panels);
  const { dockHeight, dockCollapsed, setDockHeight } = useDockStore();

  const panel = panels.find((p) => p.id === area);

  let content: React.ReactNode = null;
  if (area === 'explorer') {
    content = <BottomDock />;
  } else if (panel?.bottomPanelComponent) {
    const PanelBottom = panel.bottomPanelComponent;
    content = (
      <Suspense fallback={null}>
        <PanelBottom />
      </Suspense>
    );
  }

  if (!content) {
    return null;
  }

  return (
    <div
      data-testid="bottom-dock-wrapper"
      data-area={area}
      style={{ marginRight: showInspector ? uiPixels(detailWidth) : '0px' }}
      className="flex flex-col min-w-0 shrink-0 z-20"
    >
      {!dockCollapsed && (
        <Resizer
          orientation="horizontal"
          onDelta={(d) =>
            setDockHeight(Math.min(dockHeight - d / factor, (window.innerHeight - 170) / factor))
          }
        />
      )}
      {content}
    </div>
  );
};
