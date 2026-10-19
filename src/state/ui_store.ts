import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Perspective } from '../core/perspectives';

export type Density = 'compact' | 'comfortable';
export type RightTab = 'overview' | 'yaml';

interface UIState {
  /* appearance */
  density: Density;
  /* panels geometry */
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  inspectorWidth: number;
  inspectorCollapsed: boolean;
  dockHeight: number;
  dockCollapsed: boolean;
  /* sidebar tree groups open/closed */
  sidebarGroups: Record<string, boolean>;
  /* visible columns per kind — hidden column ids */
  hiddenColumns: Record<string, string[]>;
  /* per-kind/column pixel widths (Lens-like column resize) */
  columnWidths: Record<string, number>;
  /* transient */
  rightTab: RightTab;
  paletteOpen: boolean;
  settingsOpen: boolean;
  activeDockTab: DockTab;
  activePerspective: Perspective;

  setDensity: (d: Density) => void;
  setSidebarWidth: (w: number) => void;
  toggleSidebar: () => void;
  setInspectorWidth: (w: number) => void;
  toggleInspector: () => void;
  setDockHeight: (h: number) => void;
  toggleDock: () => void;
  openDock: (tab?: DockTab) => void;
  toggleGroup: (title: string) => void;
  setHiddenColumns: (kind: string, hidden: string[]) => void;
  setColumnWidth: (kind: string, colId: string, width: number) => void;
  resetColumnWidths: (kind?: string) => void;
  setRightTab: (t: RightTab) => void;
  setPaletteOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setActivePerspective: (p: Perspective) => void;
  resetLayout: () => void;
}

export type DockTab = 'terminal' | 'logs' | 'ports' | 'events';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export const DEFAULT_LAYOUT = {
  sidebarWidth: 246,
  inspectorWidth: 360,
  dockHeight: 260,
};

export const useUiStore = create<UIState>()(
  persist(
    (set) => ({
      density: 'compact',
      sidebarWidth: DEFAULT_LAYOUT.sidebarWidth,
      sidebarCollapsed: false,
      inspectorWidth: DEFAULT_LAYOUT.inspectorWidth,
      /* details pane opens on demand (click a row) — not at launch */
      inspectorCollapsed: true,
      dockHeight: DEFAULT_LAYOUT.dockHeight,
      /* dock stays hidden on launch — it opens on demand (⌘J / row actions) */
      dockCollapsed: true,
      sidebarGroups: {},
      hiddenColumns: {},
      columnWidths: {},
      rightTab: 'overview',
      paletteOpen: false,
      settingsOpen: false,
      activeDockTab: 'logs',
      activePerspective: 'workloads' as Perspective,

      setDensity: (density) => set({ density }),
      setSidebarWidth: (w) => set({ sidebarWidth: clamp(w, 200, 420), sidebarCollapsed: false }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setInspectorWidth: (w) => set({ inspectorWidth: clamp(w, 300, 560), inspectorCollapsed: false }),
      toggleInspector: () => set((s) => ({ inspectorCollapsed: !s.inspectorCollapsed })),
      setDockHeight: (h) => set({ dockHeight: clamp(h, 140, 560), dockCollapsed: false }),
      toggleDock: () =>
        set((s) => ({
          dockCollapsed: !s.dockCollapsed,
          dockHeight: s.dockCollapsed ? Math.max(s.dockHeight, 240) : Math.max(32, s.dockHeight),
        })),
      openDock: (tab) =>
        set((s) => ({ dockCollapsed: false, activeDockTab: (tab as DockTab) ?? s.activeDockTab })),
      toggleGroup: (title) =>
        set((s) => ({ sidebarGroups: { ...s.sidebarGroups, [title]: s.sidebarGroups[title] === false } })),
      setHiddenColumns: (kind, hidden) => set((s) => ({ hiddenColumns: { ...s.hiddenColumns, [kind]: hidden } })),
      setColumnWidth: (kind, colId, width) =>
        set((s) => ({ columnWidths: { ...s.columnWidths, [`${kind}:${colId}`]: width } })),
      resetColumnWidths: (kind) =>
        set((s) => {
          if (!kind) return { columnWidths: {} };
          const next = { ...s.columnWidths };
          for (const key of Object.keys(next)) {
            if (key.startsWith(`${kind}:`)) delete next[key];
          }
          return { columnWidths: next };
        }),
      setRightTab: (rightTab) => set({ rightTab }),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      setActivePerspective: (activePerspective) => set({ activePerspective }),
      resetLayout: () =>
        set({
          sidebarWidth: DEFAULT_LAYOUT.sidebarWidth,
          inspectorWidth: DEFAULT_LAYOUT.inspectorWidth,
          dockHeight: DEFAULT_LAYOUT.dockHeight,
          sidebarCollapsed: false,
          inspectorCollapsed: true,
          dockCollapsed: true,
        }),
    }),
    {
      name: 'kubiki.settings.v3',
      partialize: (s) => ({
        density: s.density,
        sidebarWidth: s.sidebarWidth,
        sidebarCollapsed: s.sidebarCollapsed,
        inspectorWidth: s.inspectorWidth,
        inspectorCollapsed: s.inspectorCollapsed,
        dockHeight: s.dockHeight,
        dockCollapsed: s.dockCollapsed,
        sidebarGroups: s.sidebarGroups,
        hiddenColumns: s.hiddenColumns,
        columnWidths: s.columnWidths,
      }),
    }
  )
);
