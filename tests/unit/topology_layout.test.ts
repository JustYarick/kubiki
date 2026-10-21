import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { topologyLayout, namespaceGroupId, topologyStructureKey } from '../../src/core/resources/topology_layout';
import { resourceKey } from '../../src/core/resources/identity';
import { buildResourceGraph } from '../../src/core/resources/relationships';
import { useResourceStore } from '../../src/state/resource_store';
import type { ResourceItem } from '../../src/types/k8s';

describe('Compound namespace layout', () => {
  it.each(['RIGHT', 'DOWN'] as const)('applies %s to connected nodes inside the namespace as well as the cluster', async direction => {
    const owner: ResourceItem = { uid: 'owner', kind: 'Deployment', apiVersion: 'apps/v1', name: 'owner', namespace: 'backend' };
    const pod: ResourceItem = { uid: 'pod', kind: 'Pod', apiVersion: 'v1', name: 'web', namespace: 'backend', metadata: { ownerReferences: [{ uid: owner.uid, name: owner.name, kind: owner.kind, apiVersion: owner.apiVersion }] } };
    const resources = { ...useResourceStore.getState().resources, Deployment: new Map([[owner.uid, owner]]), Pod: new Map([[pod.uid, pod]]) };
    const graph = buildResourceGraph(resources, { includeContains: false, includeMissing: false });
    const { root } = topologyLayout(graph, direction);
    const result = await new ELK().layout(root);
    const members = result.children!.find(node => node.id === namespaceGroupId('backend'))!.children!;
    const source = members.find(node => node.id === resourceKey(owner))!;
    const target = members.find(node => node.id === resourceKey(pod))!;
    if (direction === 'RIGHT') expect(source.x! + source.width!).toBeLessThan(target.x!);
    else expect(source.y! + source.height!).toBeLessThan(target.y!);
  });
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

it('changes the layout signature only for structure, independent of insertion order and live status', () => {
  const pod: ResourceItem = { uid: 'web', apiVersion: 'v1', kind: 'Pod', name: 'web', namespace: 'backend', status: 'Running' };
  const config: ResourceItem = { uid: 'config', apiVersion: 'v1', kind: 'ConfigMap', name: 'config', namespace: 'backend' };
  const a = { items: new Map([['web', pod], ['config', config]]), relations: [] };
  const b = { items: new Map([['config', config], ['web', { ...pod, status: 'Failed' }]]), relations: [] };
  expect(topologyStructureKey(a)).toBe(topologyStructureKey(b));
  b.items.delete('web'); expect(topologyStructureKey(a)).not.toBe(topologyStructureKey(b));
});
