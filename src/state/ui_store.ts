import { DEFAULT_TERMINAL_FONT, normalizeTerminalFont, normalizeTerminalLineHeight } from '../core/terminal_appearance';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useDockStore } from './dock_store';
import type { Perspective } from '../core/perspectives';
import { DEFAULT_APPEARANCE, appearanceValue, normalizeAppearance } from '../core/appearance';

export type Density = 'compact' | 'comfortable';
export type RightTab = 'overview' | 'yaml' | 'related' | 'events';

interface UIState {
  /* appearance */
  density: Density;
  uiScale: number;
  editorFontSize: number;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalLineHeight: number;
  /* panels geometry */
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  inspectorWidth: number;
  inspectorCollapsed: boolean;
  inspectorPinned: boolean;
  /* sidebar tree groups open/closed */
  sidebarGroups: Record<string, boolean>;
  sidebarTreeVersion: number;
  /* visible columns per kind — hidden column ids */
  hiddenColumns: Record<string, string[]>;
  /* per-kind/column pixel widths (Lens-like column resize) */
  columnWidths: Record<string, number>;
  /* transient */
  rightTab: RightTab;
  paletteOpen: boolean;
  settingsOpen: boolean;
  activePerspective: Perspective;

  setDensity: (d: Density) => void;
  setUiScale: (value: number) => void;
  setEditorFontSize: (value: number) => void;
  setTerminalFontSize: (value: number) => void;
  setTerminalFontFamily: (value: string) => void;
  setTerminalLineHeight: (value: number) => void;
  resetAppearance: () => void;
  setSidebarWidth: (w: number) => void;
  toggleSidebar: () => void;
  setInspectorWidth: (w: number) => void;
  toggleInspector: () => void;
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


const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export const DEFAULT_LAYOUT = {
  sidebarWidth: 246,
  inspectorWidth: 440,
  dockHeight: 260,
};

export const useUiStore = create<UIState>()(
  persist(
    (set) => ({
      density: 'compact',
      ...DEFAULT_APPEARANCE,
      terminalFontFamily: DEFAULT_TERMINAL_FONT,
      terminalLineHeight: 1.2,
      sidebarWidth: DEFAULT_LAYOUT.sidebarWidth,
      sidebarCollapsed: false,
      inspectorWidth: DEFAULT_LAYOUT.inspectorWidth,
      /* details pane opens on demand (click a row) — not at launch */
      inspectorCollapsed: true,
      inspectorPinned: false,
      /* dock stays hidden on launch — it opens on demand (⌘J / row actions) */
      sidebarGroups: {},
      sidebarTreeVersion: 2,
      hiddenColumns: {},
      columnWidths: {},
      rightTab: 'overview',
      paletteOpen: false,
      settingsOpen: false,
      activePerspective: 'workloads' as Perspective,

      setDensity: (density) => set({ density }),
      setUiScale: (value) => set({ uiScale: appearanceValue('uiScale', value) }),
      setEditorFontSize: (value) => set({ editorFontSize: appearanceValue('editorFontSize', value) }),
      setTerminalFontSize: (value) => set({ terminalFontSize: appearanceValue('terminalFontSize', value) }),
      setTerminalFontFamily: (value) => set({ terminalFontFamily: normalizeTerminalFont(value) }),
      setTerminalLineHeight: (value) => set({ terminalLineHeight: normalizeTerminalLineHeight(value) }),
      resetAppearance: () => set({ ...DEFAULT_APPEARANCE, terminalFontFamily: DEFAULT_TERMINAL_FONT, terminalLineHeight: 1.2 }),
      setSidebarWidth: (w) => set({ sidebarWidth: clamp(w, 200, 420), sidebarCollapsed: false }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setInspectorWidth: (w) => set({ inspectorWidth: clamp(w, 340, 800), inspectorCollapsed: false }),
      toggleInspector: () => set((s) => ({ inspectorCollapsed: !s.inspectorCollapsed })),
      toggleGroup: (title) =>
        set((s) => ({ sidebarGroups: { ...s.sidebarGroups, [title]: !(s.sidebarGroups[title] ?? s.sidebarGroups['*'] ?? false) } })),
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
      resetLayout: () => {
        useDockStore.getState().resetLayout();
        set({
          sidebarWidth: DEFAULT_LAYOUT.sidebarWidth,
          inspectorWidth: DEFAULT_LAYOUT.inspectorWidth,
          sidebarCollapsed: false,
          inspectorCollapsed: true,
          inspectorPinned: false,
          sidebarGroups: {},
        });
      },
    }),
    {
      name: 'kubiki.settings.v3',
      merge: (persisted, current) => ({ ...current, ...persisted as Partial<UIState>, sidebarGroups: (persisted as Partial<UIState> | undefined)?.sidebarTreeVersion === 2 ? (persisted as Partial<UIState>).sidebarGroups ?? {} : {}, sidebarTreeVersion: 2, ...normalizeAppearance(persisted as Partial<UIState> | undefined), terminalFontFamily: normalizeTerminalFont((persisted as Partial<UIState> | undefined)?.terminalFontFamily), terminalLineHeight: normalizeTerminalLineHeight((persisted as Partial<UIState> | undefined)?.terminalLineHeight) }),
      partialize: (s) => ({
        density: s.density,
        uiScale: s.uiScale,
        editorFontSize: s.editorFontSize,
        terminalFontSize: s.terminalFontSize,
        terminalFontFamily: s.terminalFontFamily,
        terminalLineHeight: s.terminalLineHeight,
        sidebarWidth: s.sidebarWidth,
        sidebarCollapsed: s.sidebarCollapsed,
        inspectorWidth: s.inspectorWidth,
        inspectorCollapsed: s.inspectorCollapsed,
        sidebarGroups: s.sidebarGroups,
        sidebarTreeVersion: 2,
        hiddenColumns: s.hiddenColumns,
        columnWidths: s.columnWidths,
      }),
    }
  )
);
