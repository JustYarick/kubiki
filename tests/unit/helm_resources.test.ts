import { beforeEach, expect, it } from 'vitest';
import { helmResource } from '../../src/core/resources/helm';
import { cacheHelmReleases, inspectHelmRelease } from '../../src/state/helm_resources';
import { useResourceStore } from '../../src/state/resource_store';
import { useClusterStore } from '../../src/state/cluster_store';
import { useWorkspaceStore, restoreWorkspace } from '../../src/state/workspace_store';
import { useUiStore } from '../../src/state/ui_store';
import type { HelmRelease } from '../../src/providers/helm_types';

const release: HelmRelease = { name: 'web', namespace: 'backend', revision: '2', status: 'deployed', chart: 'web-1', app_version: '1', updated: '' };
beforeEach(() => {
  useResourceStore.getState().reset();
  useClusterStore.getState().selectContext('prod');
  useWorkspaceStore.setState({ tabs: [], activeTabId: '', splitTabId: null });
  useUiStore.setState({ inspectorCollapsed: true, rightTab: 'yaml' });
});

it('refreshes a selected release in place and starts a new navigation chain for a list selection', () => {
  const [other] = cacheHelmReleases('prod', [{ ...release, name: 'other' }]);
  useResourceStore.getState().selectItem(other);
  inspectHelmRelease('prod', release);
  expect(useUiStore.getState()).toMatchObject({ inspectorCollapsed: false, rightTab: 'overview' });
  const selected = useResourceStore.getState().selectedItem!;
  cacheHelmReleases('prod', [{ ...release, revision: '3' }]);
  expect(useResourceStore.getState().selectedItem?.uid).toBe(selected.uid);
  expect(useResourceStore.getState().selectedItem?.raw?.release.revision).toBe('3');
  expect(useResourceStore.getState().resources.HelmRelease.size).toBe(2);
  useResourceStore.getState().goBack();
  expect(useResourceStore.getState().selectedItem?.uid).toBe(selected.uid);
  expect(useResourceStore.getState().selectionHistory).toHaveLength(0);
});

it('uses ordinary resource detail tabs for Helm and reuses a tab after an upgrade', () => {
  const store = useWorkspaceStore.getState();
  store.openResourceDetail(helmResource('prod', release));
  const original = useWorkspaceStore.getState().activeTabId;
  store.openResourceDetail(helmResource('prod', { ...release, revision: '3' }));
  expect(useWorkspaceStore.getState().tabs).toHaveLength(1);
  expect(useWorkspaceStore.getState().tabs[0]).toMatchObject({ id: original, type: 'resource-detail', kind: 'HelmRelease', context: 'prod', name: 'web', namespace: 'backend' });
  store.openResourceDetail(helmResource('prod', { ...release, namespace: 'other' }));
  expect(useWorkspaceStore.getState().tabs).toHaveLength(2);
});

it('restores old Helm tabs through the standard resource detail route', () => {
  const current = useWorkspaceStore.getState();
  const restored = restoreWorkspace({ tabs: [{ id: 'old-helm-tab', type: 'helm-release', context: 'prod', namespace: 'backend', name: 'web', title: 'Helm: web' }], activeTabId: 'old-helm-tab' }, current);
  expect(restored.tabs[0]).toMatchObject({ id: 'old-helm-tab', type: 'resource-detail', kind: 'HelmRelease', apiVersion: 'helm.sh/v1', resource: { group: 'helm.sh', name: 'web', namespace: 'backend' } });
  expect(restored.tabs[0].uid).toBe(helmResource('prod', release).uid);
});
