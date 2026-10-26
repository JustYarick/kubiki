import { expect, it } from 'vitest';
import { resourceDemand, OVERVIEW_KINDS } from '../../src/core/resources/resource_demand';
import type { WorkspaceTab } from '../../src/state/workspace_store';

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
