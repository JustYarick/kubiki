export const TOPOLOGY_UPDATE_INTERVALS = [250, 1000, 3000, 5000] as const;
export interface TopologyRenderingPreferences {
  topologyGrouping: 'namespace' | 'flat';
  topologyAnimations: boolean;
  topologyPerformanceMode: 'quality' | 'balanced' | 'performance';
  topologyShowMinimap: boolean;
  topologyEdgeStyle: 'smooth' | 'bezier' | 'straight';
  topologyShowEdgeLabels: boolean;
  topologyShowBackground: boolean;
  topologyUpdateIntervalMs: number;
}

export const DEFAULT_TOPOLOGY_RENDERING: TopologyRenderingPreferences = {
  topologyGrouping: 'namespace', topologyAnimations: false, topologyPerformanceMode: 'balanced',
  topologyShowMinimap: true, topologyEdgeStyle: 'smooth', topologyShowEdgeLabels: true,
  topologyShowBackground: true, topologyUpdateIntervalMs: 1000,
};

export function normalizeTopologyRendering(stored: Partial<TopologyRenderingPreferences> = {}): TopologyRenderingPreferences {
  const defaults = DEFAULT_TOPOLOGY_RENDERING;
  return {
    topologyGrouping: stored.topologyGrouping === 'flat' ? 'flat' : 'namespace',
    topologyPerformanceMode: stored.topologyPerformanceMode === 'quality' || stored.topologyPerformanceMode === 'performance' ? stored.topologyPerformanceMode : 'balanced',
    topologyEdgeStyle: stored.topologyEdgeStyle === 'bezier' || stored.topologyEdgeStyle === 'straight' ? stored.topologyEdgeStyle : 'smooth',
    topologyAnimations: typeof stored.topologyAnimations === 'boolean' ? stored.topologyAnimations : defaults.topologyAnimations,
    topologyShowMinimap: typeof stored.topologyShowMinimap === 'boolean' ? stored.topologyShowMinimap : defaults.topologyShowMinimap,
    topologyShowEdgeLabels: typeof stored.topologyShowEdgeLabels === 'boolean' ? stored.topologyShowEdgeLabels : defaults.topologyShowEdgeLabels,
    topologyShowBackground: typeof stored.topologyShowBackground === 'boolean' ? stored.topologyShowBackground : defaults.topologyShowBackground,
    topologyUpdateIntervalMs: (TOPOLOGY_UPDATE_INTERVALS as readonly unknown[]).includes(stored.topologyUpdateIntervalMs) ? stored.topologyUpdateIntervalMs! : defaults.topologyUpdateIntervalMs,
  };
}

/** Performance mode overrides expensive effects while preserving the user's custom choices. */
export function topologyRendering(preferences: TopologyRenderingPreferences, reducedMotion = false) {
  const fast = preferences.topologyPerformanceMode === 'performance';
  return {
    edgeType: fast || preferences.topologyEdgeStyle === 'straight' ? 'straight' as const : preferences.topologyEdgeStyle === 'bezier' ? 'default' as const : 'adjustable' as const,
    animations: !fast && !reducedMotion && preferences.topologyAnimations,
    showMinimap: !fast && preferences.topologyShowMinimap,
    showEdgeLabels: !fast && preferences.topologyShowEdgeLabels,
    showBackground: !fast && preferences.topologyShowBackground,
    compactNodes: fast,
    updateIntervalMs: Math.max(fast ? 3000 : 250, preferences.topologyUpdateIntervalMs),
  };
}
