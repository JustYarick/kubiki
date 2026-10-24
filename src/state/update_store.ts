import { useStore } from 'zustand';
import { UpdateService } from '../core/app_updates';
import { desktopUpdateAdapter, updatePreferences } from '../providers/app_updates';
import { useYamlDraftStore } from './yaml_draft_store';
import { useWorkspaceStore } from './workspace_store';
import { useMutationConfirmStore } from './mutation_confirm_store';

export function assertUpdateCanInstall() {
  const dirtyDraft = Object.values(useYamlDraftStore.getState().drafts).some(draft => draft.dirty);
  const dirtyTab = useWorkspaceStore.getState().tabs.some(tab => tab.dirty);
  if (dirtyDraft || dirtyTab) throw new Error('Save or revert your unsaved YAML edits before installing the update.');
  if (useMutationConfirmStore.getState().pending) throw new Error('Close the pending cluster change confirmation before installing the update.');
}

export const appUpdates = new UpdateService(desktopUpdateAdapter, updatePreferences, assertUpdateCanInstall);
export const useAppUpdates = () => useStore(appUpdates.store);
