import { beforeEach, expect, it } from 'vitest';
import { useWorkspaceStore, restoreWorkspace } from '../../src/state/workspace_store';
import { activeWorkspaceArea } from '../../src/core/workspace_areas';
import { resourceDemand } from '../../src/core/resources/resource_demand';

const store = () => useWorkspaceStore.getState();
const explorer = (id = 'pods') => store().openTab({ id, type: 'resource-list', kind: id === 'pods' ? 'Pod' : id === 'nodes' ? 'Node' : 'Service', title: id });
const agent = () => store().openTab({ id: 'agent', type: 'extension', panelId: 'ai-agent', title: 'AI Agent' });
const topology = (id = 'diagram') => store().openTab({ id, type: 'topology', title: id, context: 'test', uid: id === 'focused' ? 'pod-uid' : undefined });

beforeEach(() => useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true));

it('restores the Explorer document and split after opening other sections and direct resource links', () => {
  explorer(); explorer('services'); store().setSplit('pods');
  expect(store()).toMatchObject({ activeTabId: 'services', splitTabId: 'pods' });
  agent();
  expect(activeWorkspaceArea(store())).toBe('ai-agent');
  expect(store().splitTabId).toBeNull();
  topology(); store().activateArea('explorer');
  expect(store()).toMatchObject({ activeTabId: 'services', splitTabId: 'pods' });
  store().activateArea('ai-agent');
  explorer();
  expect(activeWorkspaceArea(store())).toBe('explorer');
  expect(store()).toMatchObject({ activeTabId: 'pods', splitTabId: 'services' });
});

it('never splits documents from different sections', () => {
  explorer(); agent(); store().setSplit('pods');
  expect(store().splitTabId).toBeNull();
  store().toggleSplit();
  expect(store().splitTabId).toBeNull();
  store().activateArea('explorer'); store().toggleSplit('agent');
  expect(store().splitTabId).toBeNull();
});

it('closing the last section document keeps other sections and does not display their content', () => {
  explorer(); agent(); store().closeTab('agent');
  expect(store()).toMatchObject({ activeArea: 'ai-agent', activeTabId: '', splitTabId: null });
  expect(store().tabs.map(tab => tab.id)).toEqual(['pods']);
  store().activateArea('explorer');
  expect(store().activeTabId).toBe('pods');
});

it('close others, close right and close all affect only the current section', () => {
  explorer(); agent(); explorer('services'); topology(); explorer('nodes');
  store().closeTabsToRight('services');
  expect(store().tabs.map(tab => tab.id)).toEqual(['pods', 'agent', 'services', 'diagram']);
  store().closeOtherTabs('services');
  expect(store().tabs.map(tab => tab.id)).toEqual(['agent', 'services', 'diagram']);
  store().closeAllTabs();
  expect(store().tabs.map(tab => tab.id)).toEqual(['agent', 'diagram']);
  expect(activeWorkspaceArea(store())).toBe('explorer');
});

it('focused topology belongs to the topology section and selection survives closing a hidden tab', () => {
  explorer(); topology(); topology('focused'); agent();
  store().closeTab('focused'); store().activateArea('topology');
  expect(store().activeTabId).toBe('diagram');
  expect(activeWorkspaceArea(store())).toBe('topology');
});

it('restores old persisted workspaces into sections without dropping documents', () => {
  const restored = restoreWorkspace({ tabs: [
    { id: 'pods', type: 'resource-list', title: 'Pods', kind: 'Pod' },
    { id: 'agent', type: 'extension', panelId: 'ai-agent', title: 'AI Agent' },
  ], activeTabId: 'agent' }, store());
  useWorkspaceStore.setState(restored);
  expect(activeWorkspaceArea(store())).toBe('ai-agent');
  store().activateArea('explorer');
  expect(store().activeTabId).toBe('pods');
});

it('restores saved layouts after reload and ignores closed split targets', () => {
  explorer(); explorer('services'); agent();
  const restored = restoreWorkspace({ tabs: store().tabs, activeTabId: 'services', areaSelections: {
    explorer: { activeTabId: 'services', splitTabId: 'pods', splitDirection: 'vertical' },
    'ai-agent': { activeTabId: 'agent', splitTabId: 'removed', splitDirection: 'vertical' },
  } }, useWorkspaceStore.getInitialState());
  useWorkspaceStore.setState(restored);
  expect(store()).toMatchObject({ activeArea: 'explorer', activeTabId: 'services', splitTabId: 'pods' });
  store().activateArea('ai-agent');
  expect(store()).toMatchObject({ activeTabId: 'agent', splitTabId: null });
});

it('a hidden Explorer inspector and documents do not request resources for the AI section', () => {
  explorer(); agent();
  const input = { ...store(), context: 'test', selectedItem: { uid: 'pod', kind: 'Pod', apiVersion: 'v1', name: 'web', namespace: 'default' }, inspectorCollapsed: false, rightTab: 'related' } as const;
  expect(resourceDemand(input).kinds).toEqual(['Namespace', 'CustomResourceDefinition']);
  store().activateArea('explorer'); store().closeAllTabs();
  expect(resourceDemand({ ...input, ...store(), selectedItem: null }).kinds).toEqual(['Namespace', 'CustomResourceDefinition']);
});
