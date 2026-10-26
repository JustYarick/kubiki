import { expect, it } from 'vitest';
import { DEFAULT_TOPOLOGY_RENDERING, normalizeTopologyRendering, topologyRendering } from '../../src/core/resources/topology_rendering';
import { useUiStore } from '../../src/state/ui_store';

it('performance disables expensive effects without losing the saved quality preferences', () => {
  const preferences = { ...DEFAULT_TOPOLOGY_RENDERING, topologyPerformanceMode: 'performance' as const, topologyAnimations: true };
  expect(topologyRendering(preferences)).toEqual({
    edgeType: 'straight', animations: false, showMinimap: false, showEdgeLabels: false,
    showBackground: false, compactNodes: true, updateIntervalMs: 3000,
  });
  expect(topologyRendering({ ...preferences, topologyUpdateIntervalMs: 5000 }).updateIntervalMs).toBe(5000);
  expect(topologyRendering({ ...preferences, topologyPerformanceMode: 'quality' })).toMatchObject({
    edgeType: 'adjustable', animations: true, showMinimap: true, showEdgeLabels: true, showBackground: true, compactNodes: false,
  });
});

it('respects reduced motion independently of the selected rendering profile', () => {
  expect(topologyRendering({ ...DEFAULT_TOPOLOGY_RENDERING, topologyAnimations: true }, true).animations).toBe(false);
  expect(topologyRendering({ ...DEFAULT_TOPOLOGY_RENDERING, topologyAnimations: true }, false).animations).toBe(true);
});

it('normalizes corrupt persisted settings while preserving valid existing choices', () => {
  expect(normalizeTopologyRendering()).toEqual(DEFAULT_TOPOLOGY_RENDERING);
  expect(normalizeTopologyRendering({ topologyUpdateIntervalMs: NaN, topologyAnimations: null as unknown as boolean })).toEqual(DEFAULT_TOPOLOGY_RENDERING);
  expect(normalizeTopologyRendering({ topologyGrouping: 'flat', topologyEdgeStyle: 'bezier', topologyAnimations: true })).toMatchObject({
    topologyGrouping: 'flat', topologyEdgeStyle: 'bezier', topologyAnimations: true,
  });
});

it('resets topology separately from appearance and panel geometry', () => {
  const ui = useUiStore.getState();
  ui.setTopologyPerformanceMode('performance'); ui.setTopologyShowEdgeLabels(false); ui.setTopologyUpdateIntervalMs(5000);
  ui.resetAppearance();
  expect(useUiStore.getState().topologyPerformanceMode).toBe('performance');
  ui.setSidebarWidth(300);
  ui.resetTopologyRendering();
  expect(useUiStore.getState()).toMatchObject({ ...DEFAULT_TOPOLOGY_RENDERING, sidebarWidth: 300 });
});
