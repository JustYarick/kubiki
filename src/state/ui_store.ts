import { DEFAULT_TERMINAL_FONT, normalizeTerminalFont, normalizeTerminalLineHeight } from '../core/terminal_appearance';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useDockStore } from './dock_store';
import type { Perspective } from '../core/perspectives';
import { DEFAULT_APPEARANCE, appearanceValue, normalizeAppearance } from '../core/appearance';
import type { ResourceKind } from '../types/k8s';
import { DEFAULT_TOPOLOGY_HIDDEN_KINDS } from '../core/resources/topology_visibility';
import { normalizeAiAgent, type AiAgent } from '../core/ai_analysis';

export type Density = 'compact' | 'comfortable';
export type RightTab = 'overview' | 'yaml' | 'related' | 'events';

interface UIState {
  aiAgent: AiAgent;
  setAiAgent: (agent: AiAgent) => void;
  /* appearance */
  density: Density;
  uiScale: number;
  editorFontSize: number;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalLineHeight: number;
  /* editor behavior */
  yamlCleanView: boolean;
  /* details panel default tab for freshly opened resources */
  defaultRightTab: 'overview' | 'yaml';
  /* terminal behavior */
  terminalScrollback: number;
  /** Ack waiting time for terminal output, seconds; 0 never stops a session. */
  terminalAckTimeoutSecs: number;
  /* defaults for new log sessions */
  logsWrap: boolean;
  logsTimestamps: boolean;
  logsStructured: boolean;
  /** Poll frequency for the log viewer, milliseconds. Lens-style reads. */
  logsPollMs: number;
  /** Resource kinds hidden in the topology diagram; persisted across sessions. */
  topologyHiddenKinds: ReadonlySet<ResourceKind>;
  /* cluster behavior */
  rememberNamespaceScope: boolean;
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
  /* per-kind column order — user-defined column sequence */
  columnOrder: Record<string, string[]>;
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
  setYamlCleanView: (value: boolean) => void;
  setDefaultRightTab: (value: 'overview' | 'yaml') => void;
  setTerminalScrollback: (value: number) => void;
  setTerminalAckTimeoutSecs: (value: number) => void;
  setLogsWrap: (value: boolean) => void;
  setLogsTimestamps: (value: boolean) => void;
  setLogsStructured: (value: boolean) => void;
  setLogsPollMs: (value: number) => void;
  setTopologyHiddenKinds: (value: Iterable<string>) => void;
  setRememberNamespaceScope: (value: boolean) => void;
  resetAppearance: () => void;
  setSidebarWidth: (w: number) => void;
  toggleSidebar: () => void;
  setInspectorWidth: (w: number) => void;
  toggleInspector: () => void;
  toggleGroup: (title: string) => void;
  setHiddenColumns: (kind: string, hidden: string[]) => void;
  setColumnWidth: (kind: string, colId: string, width: number) => void;
  resetColumnWidths: (kind?: string) => void;
  setColumnOrder: (kind: string, order: string[]) => void;
  resetColumnOrder: (kind?: string) => void;
  setRightTab: (t: RightTab) => void;
  setPaletteOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setActivePerspective: (p: Perspective) => void;
  resetLayout: () => void;
}


const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export const DEFAULT_LAYOUT = {
  sidebarWidth: 246,
  inspectorWidth: 520,
  dockHeight: 260,
};

export const DEFAULT_SCROLLBACK = 5000;
export const SCROLLBACK_LIMITS = { min: 500, max: 50000 } as const;
export const TERMINAL_SCROLLBACK_PRESETS = [500, 2000, 5000, 10000, 25000, 50000];
/** Ack waiting options for terminal output; 0 (default) never stops a session. */
export const TERMINAL_ACK_TIMEOUT_PRESETS = [0, 30, 60, 300] as const;
/** Log poll cadence options; 2s matches the Lens desktop defaults. */
export const LOG_POLL_PRESETS = [1000, 2000, 5000, 10000, 30000, 60000] as const;

const normalizeNumber = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? clamp(Math.round(value), min, max) : fallback;
const normalizeBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;
const normalizeTimeoutSecs = (value: unknown): number => {
  const seconds = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN;
  return (TERMINAL_ACK_TIMEOUT_PRESETS as readonly number[]).includes(seconds) ? seconds : 0;
};

export const useUiStore = create<UIState>()(
  persist(
    (set) => ({
      aiAgent: 'codex',
      setAiAgent: (agent) => set({ aiAgent: normalizeAiAgent(agent) }),
      density: 'compact',
      ...DEFAULT_APPEARANCE,
      terminalFontFamily: DEFAULT_TERMINAL_FONT,
      terminalLineHeight: 1.2,
      yamlCleanView: true,
      defaultRightTab: 'overview' as const,
      terminalScrollback: DEFAULT_SCROLLBACK,
      terminalAckTimeoutSecs: 0,
      logsWrap: true,
      logsTimestamps: true,
      logsStructured: false,
      logsPollMs: 2000,
      topologyHiddenKinds: new Set(DEFAULT_TOPOLOGY_HIDDEN_KINDS),
      rememberNamespaceScope: true,
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
      columnOrder: {},
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
      setYamlCleanView: (yamlCleanView) => set({ yamlCleanView }),
      setDefaultRightTab: (defaultRightTab) => set({ defaultRightTab }),
      setTerminalScrollback: (value) => set({ terminalScrollback: normalizeNumber(value, SCROLLBACK_LIMITS.min, SCROLLBACK_LIMITS.max, DEFAULT_SCROLLBACK) }),
      setTerminalAckTimeoutSecs: (value) => set({ terminalAckTimeoutSecs: normalizeTimeoutSecs(value) }),
      setLogsWrap: (logsWrap) => set({ logsWrap }),
      setLogsTimestamps: (logsTimestamps) => set({ logsTimestamps }),
      setLogsStructured: (logsStructured) => set({ logsStructured }),
      setLogsPollMs: (value) => set({ logsPollMs: (LOG_POLL_PRESETS as readonly number[]).includes(value) ? value : 2000 }),
      setTopologyHiddenKinds: (value) => set({ topologyHiddenKinds: new Set(value) as ReadonlySet<ResourceKind> }),
      setRememberNamespaceScope: (rememberNamespaceScope) => set({ rememberNamespaceScope }),
      resetAppearance: () => set({ ...DEFAULT_APPEARANCE, terminalFontFamily: DEFAULT_TERMINAL_FONT, terminalLineHeight: 1.2 }),
      setSidebarWidth: (w) => set({ sidebarWidth: clamp(w, 200, 420), sidebarCollapsed: false }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      // The panel can be narrowed further; the header actions collapse into a
      // menu instead of overflowing when the width drops below the button row.
      setInspectorWidth: (w) => set({ inspectorWidth: clamp(w, 320, 1000), inspectorCollapsed: false }),
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
      setColumnOrder: (kind, order) => set((s) => ({ columnOrder: { ...s.columnOrder, [kind]: order } })),
      resetColumnOrder: (kind) =>
        set((s) => {
          if (!kind) return { columnOrder: {} };
          const next = { ...s.columnOrder };
          delete next[kind];
          return { columnOrder: next };
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
      merge: (persisted, current) => {
        const stored = persisted as Partial<UIState> | undefined;
        return {
          ...current,
          ...stored as Partial<UIState>,
          aiAgent: normalizeAiAgent(stored?.aiAgent),
          inspectorWidth: clamp(stored?.inspectorWidth ?? current.inspectorWidth, 320, 1000),
          sidebarGroups: stored?.sidebarTreeVersion === 2 ? stored.sidebarGroups ?? {} : {},
          sidebarTreeVersion: 2,
          ...normalizeAppearance(stored),
          terminalFontFamily: normalizeTerminalFont(stored?.terminalFontFamily),
          terminalLineHeight: normalizeTerminalLineHeight(stored?.terminalLineHeight),
          yamlCleanView: normalizeBool(stored?.yamlCleanView, true),
          defaultRightTab: stored?.defaultRightTab === 'yaml' ? ('yaml' as const) : ('overview' as const),
          terminalScrollback: normalizeNumber(stored?.terminalScrollback, SCROLLBACK_LIMITS.min, SCROLLBACK_LIMITS.max, DEFAULT_SCROLLBACK),
          terminalAckTimeoutSecs: normalizeTimeoutSecs(stored?.terminalAckTimeoutSecs),
          logsWrap: normalizeBool(stored?.logsWrap, true),
          logsTimestamps: normalizeBool(stored?.logsTimestamps, true),
          logsStructured: normalizeBool(stored?.logsStructured, false),
          logsPollMs: normalizeNumber(stored?.logsPollMs, 500, 60000, 2000),
          topologyHiddenKinds: Array.isArray(stored?.topologyHiddenKinds)
            ? new Set(stored.topologyHiddenKinds as ResourceKind[])
            : new Set(DEFAULT_TOPOLOGY_HIDDEN_KINDS),
          rememberNamespaceScope: normalizeBool(stored?.rememberNamespaceScope, true),
        };
      },
      partialize: (s) => ({
        aiAgent: s.aiAgent,
        density: s.density,
        uiScale: s.uiScale,
        editorFontSize: s.editorFontSize,
        terminalFontSize: s.terminalFontSize,
        terminalFontFamily: s.terminalFontFamily,
        terminalLineHeight: s.terminalLineHeight,
        yamlCleanView: s.yamlCleanView,
        defaultRightTab: s.defaultRightTab,
        terminalScrollback: s.terminalScrollback,
        terminalAckTimeoutSecs: s.terminalAckTimeoutSecs,
        logsWrap: s.logsWrap,
        logsTimestamps: s.logsTimestamps,
        logsStructured: s.logsStructured,
        logsPollMs: s.logsPollMs,
        topologyHiddenKinds: [...s.topologyHiddenKinds],
        rememberNamespaceScope: s.rememberNamespaceScope,
        sidebarWidth: s.sidebarWidth,
        sidebarCollapsed: s.sidebarCollapsed,
        inspectorWidth: s.inspectorWidth,
        inspectorCollapsed: s.inspectorCollapsed,
        sidebarGroups: s.sidebarGroups,
        sidebarTreeVersion: 2,
        hiddenColumns: s.hiddenColumns,
        columnWidths: s.columnWidths,
        columnOrder: s.columnOrder,
      }),
    }
  )
);
