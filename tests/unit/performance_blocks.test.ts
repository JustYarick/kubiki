import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { PodPerformanceBlock } from '../../src/components/k8s/details/blocks/PodPerformanceBlock';
import { NodePerformanceBlock } from '../../src/components/k8s/details/blocks/NodePerformanceBlock';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';
import { useClusterStore } from '../../src/state/cluster_store';

let mockOverviewMetricsState = {
  data: undefined as any,
  loading: false,
  error: undefined as string | undefined,
  history: [] as any[],
  nodeHistory: {} as Record<string, any[]>,
  refresh: vi.fn(),
};

vi.mock('../../src/providers/use_overview_metrics', () => ({
  useOverviewMetrics: () => mockOverviewMetricsState,
}));

describe('PerformanceBlocks metrics visibility', () => {
  const podItem = mapK8sResource({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'test-pod', namespace: 'default', uid: 'pod-123' },
    spec: { containers: [{ name: 'app', resources: { limits: { cpu: '500m', memory: '512Mi' } } }] },
    status: { phase: 'Running' }
  }, 'Pod');

  beforeEach(() => {
    mockOverviewMetricsState = {
      data: undefined,
      loading: false,
      error: undefined,
      history: [],
      nodeHistory: {},
      refresh: vi.fn(),
    };
  });

  it('hides telemetry-metrics in PodPerformanceBlock when metrics.sample and history are empty', () => {
    const metricsWithoutData = {
      sample: null,
      history: [],
      usage: { cpu: null, memory: null },
      stale: false,
      error: null,
      loading: false,
      namespace: 'default',
      refresh: vi.fn(),
    };

    const html = renderToString(
      React.createElement(PodPerformanceBlock, {
        item: podItem,
        metrics: metricsWithoutData as any,
        paused: false,
        onPausedChange: vi.fn(),
      })
    );

    // Chart container should NOT be rendered
    expect(html).not.toContain('telemetry-metrics');
    // Notice banner should be rendered
    expect(html).toContain('No metrics for this Pod');
    // Fixed scale button and range dropdown should NOT be rendered
    expect(html).not.toContain('Fixed scale');
    expect(html).not.toContain('Pod metrics history range');
  });

  it('renders telemetry-metrics in PodPerformanceBlock when metrics.sample is present', () => {
    const metricsWithData = {
      sample: {
        timestamp: new Date().toISOString(),
        window: '15s',
        containers: [{ name: 'app', cpu: '100m', memory: '128Mi' }],
      },
      history: [{ at: Date.now(), cpu: 0.1, memory: 134217728 }],
      usage: { cpu: 0.1, memory: 134217728 },
      stale: false,
      error: null,
      loading: false,
      namespace: 'default',
      refresh: vi.fn(),
    };

    const html = renderToString(
      React.createElement(PodPerformanceBlock, {
        item: podItem,
        metrics: metricsWithData as any,
        paused: false,
        onPausedChange: vi.fn(),
      })
    );

    // Chart container should be rendered
    expect(html).toContain('telemetry-metrics');
    expect(html).toContain('Fixed scale');
    expect(html).toContain('Pod metrics history range');
  });

  it('hides telemetry-metrics in NodePerformanceBlock when node has no metrics', () => {
    useClusterStore.setState({ currentContext: 'test' });
    const nodeItem = mapK8sResource({
      apiVersion: 'v1',
      kind: 'Node',
      metadata: { name: 'node-1', uid: 'node-1' },
      status: {
        capacity: { cpu: '4', memory: '8Gi' },
        allocatable: { cpu: '3800m', memory: '7Gi' },
      }
    }, 'Node');

    const html = renderToString(
      React.createElement(NodePerformanceBlock, { item: nodeItem })
    );

    // No metrics sample or history exists for node-1
    expect(html).not.toContain('telemetry-metrics');
    expect(html).toContain('No metrics for this node');
    expect(html).not.toContain('Fixed scale');
    expect(html).not.toContain('Node metrics history range');
  });

  it('renders telemetry-metrics in NodePerformanceBlock when node has metrics', () => {
    useClusterStore.setState({ currentContext: 'test' });
    const nodeItem = mapK8sResource({
      apiVersion: 'v1',
      kind: 'Node',
      metadata: { name: 'node-1', uid: 'node-1' },
      status: {
        capacity: { cpu: '4', memory: '8Gi' },
        allocatable: { cpu: '3800m', memory: '7Gi' },
      }
    }, 'Node');

    mockOverviewMetricsState = {
      data: {
        nodes: {
          items: [{
            name: 'node-1',
            timestamp: new Date().toISOString(),
            window: '15s',
            cpu: '500m',
            memory: '2Gi',
          }],
          error: null,
        },
        pods: { items: [], error: null },
      } as any,
      loading: false,
      error: undefined,
      history: [],
      nodeHistory: {
        'node-1': [{ at: Date.now(), cpu: 0.5, memory: 2 * 1024 ** 3 }],
      },
      refresh: vi.fn(),
    };

    const html = renderToString(
      React.createElement(NodePerformanceBlock, { item: nodeItem })
    );

    // Chart container should be rendered
    expect(html).toContain('telemetry-metrics');
    expect(html).toContain('Fixed scale');
    expect(html).toContain('Node metrics history range');
    expect(html).not.toContain('No metrics for this node');
  });
});
