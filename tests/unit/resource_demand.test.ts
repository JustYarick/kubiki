import { expect, it } from 'vitest';
import { resourceDemand, relatedResourceKinds, OVERVIEW_KINDS } from '../../src/core/resources/resource_demand';
import type { WorkspaceTab } from '../../src/state/workspace_store';
import { RESOURCE_TYPES } from '../../src/core/resources/resource_types';

function demand(tabs: WorkspaceTab[], activeTabId = tabs[0]?.id ?? '', splitTabId: string | null = null) {
  return resourceDemand({ context: 'test', tabs, activeTabId, splitTabId, selectedItem: null, inspectorCollapsed: true, rightTab: 'overview' });
}
const tab = (id: string, kind: WorkspaceTab['kind']): WorkspaceTab => ({ id, kind, type: 'resource-list', title: id });
it('does not keep full inventories watched when no view needs them', () => {
  expect(demand([]).kinds).toEqual(['Namespace', 'CustomResourceDefinition']);
  const result = demand([tab('pods', 'Pod'), tab('secrets', 'Secret')]);
  expect(result.kinds).toEqual(['Namespace', 'CustomResourceDefinition', 'Pod']);
  expect(result.clusterKinds.size).toBe(0);
});
it('unions split panes and loads the dependencies for workload actions', () => {
  const result = demand([tab('deployment', 'Deployment'), tab('services', 'Service'), tab('secrets', 'Secret')], 'deployment', 'services');
  expect(result.kinds).toEqual(expect.arrayContaining(['Deployment', 'Pod', 'ReplicaSet', 'Service']));
  expect(result.kinds).not.toContain('Secret');
  expect(new Set(result.kinds).size).toBe(result.kinds.length);
});
it('keeps global Pod coverage only when a Node view needs it', () => {
  expect([...demand([tab('nodes', 'Node')]).clusterKinds]).toEqual(['Pod']);
  expect(demand([tab('nodes', 'Node'), tab('pods', 'Pod')], 'pods').clusterKinds.size).toBe(0);
});
it('loads summary sources without continuously watching Secrets or unrelated admission policies', () => {
  const result = demand([{ id: 'overview', title: 'Overview', type: 'overview' }]);
  expect(result.kinds).toEqual(expect.arrayContaining([...OVERVIEW_KINDS]));
  expect(result.kinds).not.toContain('Secret');
  expect(result.kinds).not.toContain('MutatingAdmissionPolicy');
});
it('ignores tabs pinned to another cluster', () => {
  expect(demand([{ ...tab('secret', 'Secret'), context: 'other' }]).kinds).not.toContain('Secret');
});
it('does not trigger cluster-wide Pod or workload watches when opening Helm Releases', () => {
  const result = demand([{ id: 'helm-releases', title: 'Helm Releases', type: 'helm-releases' }]);
  expect(result.kinds).toEqual(['Namespace', 'CustomResourceDefinition']);
});
it('Related requests potential neighbours instead of every resource collection', () => {
  const pod = { uid: 'pod', name: 'pod', namespace: 'test', kind: 'Pod', apiVersion: 'v1' };
  const result = resourceDemand({ context: 'test', tabs: [], activeTabId: '', splitTabId: null, selectedItem: pod, inspectorCollapsed: false, rightTab: 'related' });
  expect(result.kinds).toEqual(expect.arrayContaining(['Pod', 'Node', 'ReplicaSet', 'Deployment', 'PriorityClass', 'Service', 'EndpointSlice', 'ResourceClaim']));
  expect(result.kinds).toContain('StorageClass');
  for (const type of RESOURCE_TYPES) if (!type.namespaced) expect(result.kinds).toContain(type.kind);
  for (const kind of result.kinds) if (RESOURCE_TYPES.find(type => type.kind === kind)?.namespaced) expect(result.scopes.get(kind)).toBe('test');
  expect(relatedResourceKinds({ ...pod, kind: 'Deployment', apiVersion: 'apps/v1' })).toContain('ReplicaSet');
  expect(relatedResourceKinds({ ...pod, kind: 'PriorityClass', apiVersion: 'scheduling.k8s.io/v1' })).toEqual(expect.arrayContaining(['Pod', 'Deployment', 'StatefulSet']));
});
it('keeps Related namespace-local with All Namespaces and unions only independently visible consumers', () => {
  const item = { uid: 'pod', name: 'pod', namespace: 'backend', kind: 'Pod', apiVersion: 'v1' };
  const input = { context: 'test', tabs: [tab('pods', 'Pod')], activeTabId: 'pods', splitTabId: null, selectedNamespace: 'all', selectedItem: item, inspectorCollapsed: false, rightTab: 'related' };
  const result = resourceDemand(input);
  expect(result.scopes.get('Pod')).toBe('all'); // The visible all-namespace Pod table.
  for (const kind of result.kinds) if (kind !== 'Pod' && RESOURCE_TYPES.find(type => type.kind === kind)?.namespaced) expect(result.scopes.get(kind)).toBe('backend');
  const pinned = { id: 'detail', type: 'resource-detail', title: 'pod', kind: 'Pod', namespace: 'backend' } as WorkspaceTab;
  const detail = resourceDemand({ ...input, tabs: [pinned], activeTabId: 'detail', inspectorCollapsed: true });
  for (const kind of detail.kinds) if (RESOURCE_TYPES.find(type => type.kind === kind)?.namespaced) expect(detail.scopes.get(kind)).toBe('backend');
  const split = resourceDemand({ ...input, tabs: [pinned, { ...pinned, id: 'other', namespace: 'other' }], activeTabId: 'detail', splitTabId: 'other', inspectorCollapsed: true });
  expect(split.scopes.get('Pod')).toBe('["backend","other"]');
  expect(split.scopes.get('Secret')).toBe('["backend","other"]');
});
it('scopes Namespace members to the Namespace name even when the global selection is all', () => {
  const result = resourceDemand({ context: 'test', tabs: [], activeTabId: '', splitTabId: null, selectedNamespace: 'all', selectedItem: { uid: 'ns', kind: 'Namespace', apiVersion: 'v1', name: 'backend' }, inspectorCollapsed: false, rightTab: 'related' });
  for (const kind of result.kinds) if (RESOURCE_TYPES.find(type => type.kind === kind)?.namespaced) expect(result.scopes.get(kind)).toBe('backend');
});
