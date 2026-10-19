import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { topologyLayout, namespaceGroupId } from '../../src/core/resources/topology_layout';
import { resourceKey } from '../../src/core/resources/identity';
import { buildResourceGraph } from '../../src/core/resources/relationships';
import { useResourceStore } from '../../src/state/resource_store';
import type { ResourceItem } from '../../src/types/k8s';

describe('Compound namespace layout', () => {
  it.each(['RIGHT', 'DOWN'] as const)('keeps Pod/config inside its namespace and a referenced Node outside (%s)', async (direction) => {
    const resources = { ...useResourceStore.getState().resources };
    const namespace: ResourceItem = { uid: 'ns', kind: 'Namespace', apiVersion: 'v1', name: 'backend' };
    const pod: ResourceItem = { uid: 'pod', kind: 'Pod', apiVersion: 'v1', name: 'web', namespace: 'backend', spec: { nodeName: 'worker', volumes: [{ configMap: { name: 'config' } }] } };
    const config: ResourceItem = { uid: 'config', kind: 'ConfigMap', apiVersion: 'v1', name: 'config', namespace: 'backend' };
    const node: ResourceItem = { uid: 'node', kind: 'Node', apiVersion: 'v1', name: 'worker' };
    for (const item of [namespace, pod, config, node]) resources[item.kind] = new Map([[item.uid, item]]);
    const graph = buildResourceGraph(resources, { includeContains: false, includeMissing: false });
    const { root } = topologyLayout(graph, direction);
    const elk = new ELK();
    const result = await elk.layout(root);
    const group = result.children!.find((item) => item.id === namespaceGroupId('backend'))!;
    expect(group.children!.map((item) => item.id).sort()).toEqual([resourceKey(config), resourceKey(pod)].sort());
    for (const child of group.children!) {
      expect(child.x).toBeGreaterThanOrEqual(24); expect(child.y).toBeGreaterThanOrEqual(48);
      expect(child.x! + child.width!).toBeLessThanOrEqual(group.width! - 24);
      expect(child.y! + child.height!).toBeLessThanOrEqual(group.height! - 24);
    }
    const external = result.children!.find((item) => item.id === resourceKey(node))!;
    expect(external.children).toBeUndefined();
    const overlaps = external.x! < group.x! + group.width! && external.x! + external.width! > group.x! && external.y! < group.y! + group.height! && external.y! + external.height! > group.y!;
    expect(overlaps).toBe(false);
  });
});
