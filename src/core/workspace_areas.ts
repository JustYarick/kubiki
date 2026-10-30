import type { WorkspaceTab } from '../state/workspace_store';

/** Sections own their documents; switching sections preserves the previous layout. */
export function workspaceArea(tab: WorkspaceTab): string {
  if (tab.type === 'topology') return 'topology';
  if (tab.type === 'extension' && tab.panelId) return tab.panelId;
  return 'explorer';
}

export function activeWorkspaceArea(state: { tabs: readonly WorkspaceTab[]; activeTabId: string; activeArea?: string }): string {
  const tab = state.tabs.find(tab => tab.id === state.activeTabId);
  return tab ? workspaceArea(tab) : state.activeArea ?? 'explorer';
}

export function areaHasInspector(area: string): boolean {
  return area === 'explorer' || area === 'topology';
}
