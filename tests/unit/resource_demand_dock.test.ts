import { expect, it } from 'vitest';
import { resourceDemand } from '../../src/core/resources/resource_demand';

it('keeps targets current while the Ports picker is visible and releases them when it closes', () => {
  const workspace = { context: 'test', tabs: [], activeTabId: '', splitTabId: null, selectedItem: null, inspectorCollapsed: true, rightTab: 'overview' };
  expect(resourceDemand({ ...workspace, portsVisible: true }).kinds).toEqual(['Namespace', 'CustomResourceDefinition', 'Pod', 'Service']);
  expect(resourceDemand({ ...workspace, portsVisible: false }).kinds).toEqual(['Namespace', 'CustomResourceDefinition']);
});
