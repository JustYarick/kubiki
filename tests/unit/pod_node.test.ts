import { describe, expect, it } from 'vitest';
import {
  extractPinnedPodNode,
  podNodeInfo,
  summarizePodAffinity,
} from '../../src/core/resources/pod_node';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';
import { columnsFor } from '../../src/components/k8s/table/columns';
import { searchDocument } from '../../src/core/resource_search';
import { buildResourceGraph } from '../../src/core/resources/relationships';
import type { ResourceItem, ResourceKind } from '../../src/types/k8s';

describe('Pod node resolution across workload controllers', () => {
  it('extracts target node from DaemonSet pending pod nodeAffinity matchFields without faking spec.nodeName', () => {
    const raw = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        uid: 'pod-ds-1',
        name: 'node-exporter-abcde',
        namespace: 'monitoring',
        ownerReferences: [{ apiVersion: 'apps/v1', kind: 'DaemonSet', name: 'node-exporter', uid: 'ds-1', controller: true }],
      },
      spec: {
        affinity: {
          nodeAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: {
              nodeSelectorTerms: [
                {
                  matchExpressions: [{ key: 'kubernetes.io/os', operator: 'In', values: ['linux'] }],
                  matchFields: [{ key: 'metadata.name', operator: 'In', values: ['infra-node-3'] }],
                },
                {
                  matchExpressions: [{ key: 'kubernetes.io/arch', operator: 'In', values: ['amd64'] }],
                  matchFields: [{ key: 'metadata.name', operator: 'In', values: ['infra-node-3'] }],
                },
              ],
            },
          },
        },
        containers: [{ name: 'exporter', image: 'prom/node-exporter:v1' }],
      },
      status: {
        phase: 'Pending',
        conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/5 nodes are available' }],
      },
    };

    const item = mapK8sResource(raw, 'Pod');
    // Authoritative bound node stays unset so capacity/drain math never counts unscheduled pods.
    expect(item.node).toBe('-');
    expect(item.targetNode).toBe('infra-node-3');
    expect(item.targetNodeSource).toBe('nodeAffinity');

    const info = podNodeInfo(item);
    expect(info.assigned).toBeUndefined();
    expect(info.target).toBe('infra-node-3');
    expect(info.targetSource).toBe('nodeAffinity');
    expect(info.pendingNode).toBe('infra-node-3');

    // Pods table Node column and search index expose the target node.
    const nodeCol = columnsFor('Pod').find((c) => c.id === 'node')!;
    expect(nodeCol.get(item)).toBe('infra-node-3');
    expect(searchDocument(item).fields.node).toContain('infra-node-3');

    // Relationship graph emits a 'targets' edge to the Node without claiming 'schedules'.
    const nodeItem = mapK8sResource(
      { apiVersion: 'v1', kind: 'Node', metadata: { uid: 'node-3', name: 'infra-node-3' }, status: {} },
      'Node'
    );
    const resources = {
      Pod: new Map([[item.uid, item]]),
      Node: new Map([[nodeItem.uid, nodeItem]]),
    } as Record<ResourceKind, Map<string, ResourceItem>>;
    const graph = buildResourceGraph(resources, { includeContains: false, includeMissing: false });
    expect(graph.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'schedules', label: 'targets' }),
      ])
    );
  });

  it('rejects ambiguous OR nodeAffinity terms or multi-node lists', () => {
    expect(
      extractPinnedPodNode({
        affinity: {
          nodeAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: {
              nodeSelectorTerms: [
                { matchFields: [{ key: 'metadata.name', operator: 'In', values: ['node-a'] }] },
                { matchFields: [{ key: 'metadata.name', operator: 'In', values: ['node-b'] }] },
              ],
            },
          },
        },
      })
    ).toBeUndefined();

    expect(
      extractPinnedPodNode({
        affinity: {
          nodeAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: {
              nodeSelectorTerms: [
                { matchFields: [{ key: 'metadata.name', operator: 'In', values: ['node-a', 'node-b'] }] },
              ],
            },
          },
        },
      })
    ).toBeUndefined();
  });

  it('supports hostname matchExpressions, nodeSelector hostname, nominatedNodeName, and bound spec.nodeName', () => {
    expect(
      extractPinnedPodNode({
        affinity: {
          nodeAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: {
              nodeSelectorTerms: [
                { matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: ['worker-5'] }] },
              ],
            },
          },
        },
      })
    ).toEqual({ node: 'worker-5', source: 'nodeAffinity' });

    expect(
      extractPinnedPodNode({
        nodeSelector: { 'kubernetes.io/hostname': 'worker-7', 'node-role.kubernetes.io/infra': '' },
      })
    ).toEqual({ node: 'worker-7', source: 'nodeSelector' });

    const nominated = podNodeInfo({
      spec: {},
      status: { phase: 'Pending', nominatedNodeName: 'worker-b' },
    });
    expect(nominated.assigned).toBeUndefined();
    expect(nominated.nominated).toBe('worker-b');
    expect(nominated.pendingNode).toBe('worker-b');
    expect(nominated.pendingSource).toBe('nominated');

    const bound = podNodeInfo({
      spec: {
        nodeName: 'worker-1',
        nodeSelector: { 'kubernetes.io/hostname': 'worker-1' },
      },
      status: { phase: 'Running' },
    });
    expect(bound.assigned).toBe('worker-1');
    expect(bound.pendingNode).toBeUndefined();
  });

  it('summarizes nodeAffinity, podAffinity, and podAntiAffinity for PodDetails', () => {
    const summary = summarizePodAffinity({
      nodeAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [
            { matchFields: [{ key: 'metadata.name', operator: 'In', values: ['worker-3'] }] },
          ],
        },
        preferredDuringSchedulingIgnoredDuringExecution: [
          {
            weight: 100,
            preference: {
              matchExpressions: [{ key: 'zone', operator: 'In', values: ['eu-1a'] }],
            },
          },
        ],
      },
      podAntiAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: [
          {
            topologyKey: 'kubernetes.io/hostname',
            labelSelector: { matchLabels: { app: 'qdrant' } },
          },
        ],
      },
    });
    expect(summary?.nodeAffinity?.requiredTerms).toHaveLength(1);
    expect(summary?.nodeAffinity?.requiredTerms[0][0]).toMatchObject({
      key: 'metadata.name',
      operator: 'In',
      values: ['worker-3'],
      kind: 'field',
    });
    expect(summary?.nodeAffinity?.preferredTerms[0].weight).toBe(100);
    expect(summary?.podAntiAffinity?.required[0]).toEqual({
      topologyKey: 'kubernetes.io/hostname',
      namespaces: undefined,
      selector: 'app=qdrant',
    });
  });
});
