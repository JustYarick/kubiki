import type { LogTimestampZone } from '../core/utils/log_timestamp';
import { DEFAULT_TERMINAL_FONT, normalizeTerminalFont, normalizeTerminalLineHeight } from '../core/terminal_appearance';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useDockStore } from './dock_store';
import type { Perspective } from '../core/perspectives';
import { DEFAULT_APPEARANCE, appearanceValue, normalizeAppearance } from '../core/appearance';
import type { ResourceKind } from '../types/k8s';
import { DEFAULT_TOPOLOGY_HIDDEN_KINDS } from '../core/resources/topology_visibility';
import { DEFAULT_TOPOLOGY_RENDERING, normalizeTopologyRendering, type TopologyRenderingPreferences } from '../core/resources/topology_rendering';
import { ANALYSIS_INSTRUCTIONS, normalizeAnalysisPrompt, normalizeAiAgent, type AiAgent } from '../core/ai_analysis';

export type Density = 'compact' | 'comfortable';
export type RightTab = 'overview' | 'yaml' | 'related' | 'events';

interface UIState extends TopologyRenderingPreferences {
  developerMode: boolean;
  setDeveloperMode: (enabled: boolean) => void;
  aiAnalysisPrompt: string;
  setAiAnalysisPrompt: (prompt: string) => void;
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
  /* editor behavior */
  yamlHideManagedFields: boolean;
  /* defaults for new log sessions */
  logsWrap: boolean;
  logsTimestamps: boolean;
  logsTimestampZone: LogTimestampZone;
  logsStructured: boolean;
  logsColorLevels: boolean;
  /** Poll frequency for the log viewer, milliseconds. Lens-style reads. */
  logsPollMs: number;
  logsDefaultTail: number;
  logsMaxBufferLines: number;
  logsScrollStickiness: number;
  /* port forwarding defaults */
  portForwardLocalRange: string;
  portForwardAutoOpen: boolean;
  /* topology rendering and performance */
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
  setYamlHideManagedFields: (value: boolean) => void;
  setDefaultRightTab: (value: 'overview' | 'yaml') => void;
  setTerminalScrollback: (value: number) => void;
  setTerminalAckTimeoutSecs: (value: number) => void;
  setLogsWrap: (value: boolean) => void;
  setLogsTimestamps: (value: boolean) => void;
  setLogsTimestampZone: (value: LogTimestampZone) => void;
  setLogsStructured: (value: boolean) => void;
  setLogsColorLevels: (value: boolean) => void;
  setLogsPollMs: (value: number) => void;
  setLogsDefaultTail: (value: number) => void;
  setLogsMaxBufferLines: (value: number) => void;
  setLogsScrollStickiness: (value: number) => void;
  setPortForwardLocalRange: (value: string) => void;
  setPortForwardAutoOpen: (value: boolean) => void;
  setTopologyGrouping: (value: 'namespace' | 'flat') => void;
  setTopologyAnimations: (value: boolean) => void;
  setTopologyPerformanceMode: (value: 'quality' | 'balanced' | 'performance') => void;
  setTopologyShowMinimap: (value: boolean) => void;
  setTopologyEdgeStyle: (value: 'smooth' | 'bezier' | 'straight') => void;
  setTopologyShowEdgeLabels: (value: boolean) => void;
  setTopologyShowBackground: (value: boolean) => void;
  setTopologyUpdateIntervalMs: (value: number) => void;
  resetTopologyRendering: () => void;
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
export const LOG_TAIL_PRESETS = [100, 500, 1000, 5000] as const;
export const LOG_BUFFER_PRESETS = [1000, 5000, 10000, 25000] as const;
export const LOG_STICKINESS_PRESETS = [20, 40, 80, 120] as const;

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
      developerMode: false,
      setDeveloperMode: (enabled) => set({ developerMode: enabled }),
      aiAnalysisPrompt: ANALYSIS_INSTRUCTIONS,
      setAiAnalysisPrompt: (prompt) => set({ aiAnalysisPrompt: normalizeAnalysisPrompt(prompt) }),
      aiAgent: 'codex',
      setAiAgent: (agent) => set({ aiAgent: normalizeAiAgent(agent) }),
      density: 'compact',
      ...DEFAULT_APPEARANCE,
      terminalFontFamily: DEFAULT_TERMINAL_FONT,
      terminalLineHeight: 1.2,
      yamlCleanView: true,
      yamlHideManagedFields: true,
      defaultRightTab: 'overview' as const,
      terminalScrollback: DEFAULT_SCROLLBACK,
      terminalAckTimeoutSecs: 0,
      logsWrap: true,
      logsTimestamps: true,
      logsTimestampZone: 'utc',
      logsStructured: false,
      logsColorLevels: false,
      logsPollMs: 2000,
      logsDefaultTail: 500,
      logsMaxBufferLines: 1000,
      logsScrollStickiness: 40,
      portForwardLocalRange: '8000-8999',
      portForwardAutoOpen: false,
      ...DEFAULT_TOPOLOGY_RENDERING,
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
      setYamlHideManagedFields: (yamlHideManagedFields) => set({ yamlHideManagedFields }),
      setDefaultRightTab: (defaultRightTab) => set({ defaultRightTab }),
      setTerminalScrollback: (value) => set({ terminalScrollback: normalizeNumber(value, SCROLLBACK_LIMITS.min, SCROLLBACK_LIMITS.max, DEFAULT_SCROLLBACK) }),
      setTerminalAckTimeoutSecs: (value) => set({ terminalAckTimeoutSecs: normalizeTimeoutSecs(value) }),
      setLogsWrap: (logsWrap) => set({ logsWrap }),
      setLogsTimestamps: (logsTimestamps) => set({ logsTimestamps }),
      setLogsTimestampZone: (value) => set({ logsTimestampZone: value === 'local' ? 'local' : 'utc' }),
      setLogsStructured: (logsStructured) => set({ logsStructured }),
      setLogsColorLevels: (logsColorLevels) => set({ logsColorLevels }),
      setLogsPollMs: (value) => set({ logsPollMs: (LOG_POLL_PRESETS as readonly number[]).includes(value) ? value : 2000 }),
      setLogsDefaultTail: (value) => set({ logsDefaultTail: (LOG_TAIL_PRESETS as readonly number[]).includes(value as any) ? value : 500 }),
      setLogsMaxBufferLines: (value) => set({ logsMaxBufferLines: (LOG_BUFFER_PRESETS as readonly number[]).includes(value as any) ? value : 1000 }),
      setLogsScrollStickiness: (value) => set({ logsScrollStickiness: (LOG_STICKINESS_PRESETS as readonly number[]).includes(value as any) ? value : 40 }),
      setPortForwardLocalRange: (portForwardLocalRange) => set({ portForwardLocalRange }),
      setPortForwardAutoOpen: (portForwardAutoOpen) => set({ portForwardAutoOpen }),
      setTopologyGrouping: (topologyGrouping) => set({ topologyGrouping }),
      setTopologyAnimations: (topologyAnimations) => set({ topologyAnimations }),
      setTopologyPerformanceMode: (topologyPerformanceMode) => set({ topologyPerformanceMode }),
      setTopologyShowMinimap: (topologyShowMinimap) => set({ topologyShowMinimap }),
      setTopologyEdgeStyle: (topologyEdgeStyle) => set({ topologyEdgeStyle }),
      setTopologyShowEdgeLabels: (topologyShowEdgeLabels) => set({ topologyShowEdgeLabels }),
      setTopologyShowBackground: (topologyShowBackground) => set({ topologyShowBackground }),
      setTopologyUpdateIntervalMs: (value) => set({ topologyUpdateIntervalMs: normalizeTopologyRendering({ topologyUpdateIntervalMs: value }).topologyUpdateIntervalMs }),
      resetTopologyRendering: () => set({ ...DEFAULT_TOPOLOGY_RENDERING }),
      setTopologyHiddenKinds: (value) => set({ topologyHiddenKinds: new Set(value) as ReadonlySet<ResourceKind> }),
      setRememberNamespaceScope: (rememberNamespaceScope) => set({ rememberNamespaceScope }),
      resetAppearance: () =>
        set({
          ...DEFAULT_APPEARANCE,
          terminalFontFamily: DEFAULT_TERMINAL_FONT,
          terminalLineHeight: 1.2,
        }),
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
          developerMode: normalizeBool(stored?.developerMode, false),
          aiAnalysisPrompt: normalizeAnalysisPrompt(stored?.aiAnalysisPrompt),
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
          yamlHideManagedFields: normalizeBool(stored?.yamlHideManagedFields, true),
          logsWrap: normalizeBool(stored?.logsWrap, true),
          logsTimestamps: normalizeBool(stored?.logsTimestamps, true),
          logsTimestampZone: stored?.logsTimestampZone === 'local' ? 'local' : 'utc',
          logsStructured: normalizeBool(stored?.logsStructured, false),
          logsColorLevels: normalizeBool(stored?.logsColorLevels, false),
          logsPollMs: normalizeNumber(stored?.logsPollMs, 500, 60000, 2000),
          logsDefaultTail: normalizeNumber(stored?.logsDefaultTail, 100, 5000, 500),
          logsMaxBufferLines: normalizeNumber(stored?.logsMaxBufferLines, 1000, 25000, 1000),
          logsScrollStickiness: normalizeNumber(stored?.logsScrollStickiness, 20, 200, 40),
          portForwardLocalRange: typeof stored?.portForwardLocalRange === 'string' ? stored.portForwardLocalRange : '8000-8999',
          portForwardAutoOpen: normalizeBool(stored?.portForwardAutoOpen, false),
          ...normalizeTopologyRendering(stored),
          topologyHiddenKinds: Array.isArray(stored?.topologyHiddenKinds)
            ? new Set(stored.topologyHiddenKinds as ResourceKind[])
            : new Set(DEFAULT_TOPOLOGY_HIDDEN_KINDS),
          rememberNamespaceScope: normalizeBool(stored?.rememberNamespaceScope, true),
        };
      },
      partialize: (s) => ({
        aiAgent: s.aiAgent,
        developerMode: s.developerMode,
        aiAnalysisPrompt: s.aiAnalysisPrompt,
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
        yamlHideManagedFields: s.yamlHideManagedFields,
        logsWrap: s.logsWrap,
        logsTimestamps: s.logsTimestamps,
        logsTimestampZone: s.logsTimestampZone,
        logsStructured: s.logsStructured,
        logsColorLevels: s.logsColorLevels,
        logsPollMs: s.logsPollMs,
        logsDefaultTail: s.logsDefaultTail,
        logsMaxBufferLines: s.logsMaxBufferLines,
        logsScrollStickiness: s.logsScrollStickiness,
        portForwardLocalRange: s.portForwardLocalRange,
        portForwardAutoOpen: s.portForwardAutoOpen,
        topologyGrouping: s.topologyGrouping,
        topologyAnimations: s.topologyAnimations,
        topologyPerformanceMode: s.topologyPerformanceMode,
        topologyShowMinimap: s.topologyShowMinimap,
        topologyEdgeStyle: s.topologyEdgeStyle,
        topologyShowEdgeLabels: s.topologyShowEdgeLabels,
        topologyShowBackground: s.topologyShowBackground,
        topologyUpdateIntervalMs: s.topologyUpdateIntervalMs,
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
