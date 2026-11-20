/**
 * Topology visibility defaults, readiness gating, and rendering/performance settings.
 *
 * WHY THIS SUITE EXISTS:
 * Topology diagrams sit on top of live multi-kind watches. These tests protect three invariants:
 * 1. Primary service/workload kinds remain visible by default while noisy secondary kinds stay hidden.
 * 2. First-paint readiness waits for complete context/namespace snapshots and settles unavailable APIs
 *    without hanging forever.
 * 3. Performance mode and `prefers-reduced-motion` disable expensive visual effects without destroying
 *    persisted user preferences.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOPOLOGY_HIDDEN_KINDS } from '../../src/core/resources/topology_visibility';
import { topologyReadiness } from '../../src/core/resources/topology_readiness';
import { DEFAULT_TOPOLOGY_RENDERING, normalizeTopologyRendering, topologyRendering } from '../../src/core/resources/topology_rendering';
import type { WatchState } from '../../src/providers/watch_types';
import { useUiStore } from '../../src/state/ui_store';

describe('Topology default visibility', () => {
  it('keeps the service structure visible and hides secondary resources by default', () => {
    const hidden = DEFAULT_TOPOLOGY_HIDDEN_KINDS;
    for (const kind of ['PodDisruptionBudget', 'NetworkPolicy', 'HorizontalPodAutoscaler', 'ServiceAccount', 'Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding', 'Endpoints', 'EndpointSlice', 'ResourceQuota', 'LimitRange', 'Lease', 'ReplicationController', 'ValidatingWebhookConfiguration', 'IngressClass', 'PriorityClass', 'RuntimeClass', 'DeviceClass', 'ResourceClaim']) {
      expect(hidden.has(kind), `${kind} should be hidden by default`).toBe(true);
    }
    for (const kind of ['Pod', 'Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Service', 'Ingress', 'ConfigMap', 'Secret', 'PersistentVolumeClaim', 'HelmRelease', 'Namespace', 'Node']) {
      expect(hidden.has(kind), `${kind} should be visible by default`).toBe(false);
    }
  });

  it('persists the user choice of hidden kinds and restores the default set', () => {
    useUiStore.getState().setTopologyHiddenKinds(new Set(['ResourceQuota']));
    expect(useUiStore.getState().topologyHiddenKinds.has('ResourceQuota')).toBe(true);
    useUiStore.getState().setTopologyHiddenKinds(new Set(DEFAULT_TOPOLOGY_HIDDEN_KINDS));
    expect(useUiStore.getState().topologyHiddenKinds.has('PodDisruptionBudget')).toBe(true);
    expect(useUiStore.getState().topologyHiddenKinds.size).toBe(DEFAULT_TOPOLOGY_HIDDEN_KINDS.size);
  });
});

describe('Topology snapshot readiness', () => {
  const watched = (kind: string, patch: Partial<WatchState> = {}): WatchState => ({
    query: { context: 'test', group: '', version: 'v1', kind, namespace: 'team' },
    phase: 'live',
    hasSnapshot: true,
    ...patch,
  });
  const input = {
    context: 'test',
    namespace: 'team',
    kinds: ['Pod', 'Service'],
    availableKinds: ['Pod', 'Service'],
    mode: 'watch',
    connected: true,
    clusterLoading: false,
    watches: {},
    loading: {},
    errors: {},
  };

  it('does not treat an empty not-yet-loaded map as a complete snapshot', () => {
    expect(topologyReadiness(input)).toMatchObject({ ready: false, pending: ['Pod', 'Service'] });
    expect(topologyReadiness({ ...input, watches: { Pod: watched('Pod') } })).toMatchObject({ ready: false, pending: ['Service'] });
    expect(topologyReadiness({ ...input, watches: { Pod: watched('Pod'), Service: watched('Service') } }).ready).toBe(true);
  });

  it('requires the selected context and complete namespace coverage', () => {
    expect(topologyReadiness({ ...input, watches: { Pod: watched('Pod', { query: { ...watched('Pod').query, context: 'old' } }), Service: watched('Service') } }).ready).toBe(false);
    expect(topologyReadiness({ ...input, namespace: '["team","other"]', watches: { Pod: watched('Pod'), Service: watched('Service') } }).ready).toBe(false);
    expect(topologyReadiness({ ...input, watches: { Pod: watched('Pod', { query: { ...watched('Pod').query, namespace: null } }), Service: watched('Service') } }).ready).toBe(true);
  });

  it('settles unavailable APIs without waiting forever and ignores events and unsupported kinds', () => {
    expect(topologyReadiness({ ...input, kinds: ['Pod', 'Service', 'Event', 'Job'], watches: { Pod: watched('Pod'), Service: watched('Service', { phase: 'failed', hasSnapshot: false }) } })).toMatchObject({ ready: true, unavailable: ['Service'], pending: [] });
  });

  it('does not use stopped or connecting cached snapshots for first drawing', () => {
    for (const phase of ['connecting', 'stopped'] as const) {
      expect(topologyReadiness({ ...input, watches: { Pod: watched('Pod', { phase }), Service: watched('Service') } }).ready).toBe(false);
    }
  });

  it('waits for all demo snapshots and never publishes a disconnected cluster', () => {
    expect(topologyReadiness({ ...input, mode: 'demo', loading: { Pod: false } }).ready).toBe(false);
    expect(topologyReadiness({ ...input, mode: 'demo', loading: { Pod: false, Service: false } }).ready).toBe(true);
    expect(topologyReadiness({ ...input, mode: 'demo', connected: false, loading: { Pod: false, Service: false } }).ready).toBe(false);
  });
});

describe('Topology rendering profiles and settings', () => {
  it('performance mode disables expensive effects without losing saved quality preferences', () => {
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
});
