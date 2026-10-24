import { Puzzle, type LucideIcon } from 'lucide-react';
import { RedisIcon } from '../components/ui/RedisIcon';
import { KafkaIcon } from '../components/ui/KafkaIcon';
import { create } from 'zustand';
import {
  extensionRequest,
  type InstalledExtension,
} from '../providers/extensions';
import { registerWorkspacePanel } from '../core/workspace_panels';
import { ExtensionPanel } from './ExtensionPanel';
import { useUiStore } from '../state/ui_store';
import { useWorkspaceStore } from '../state/workspace_store';

export const extensionVisible = (extension: InstalledExtension, developerMode: boolean) =>
  extension.manifest.id !== 'kubiki.sdk-test' || developerMode;
const registrations = new Map<
  string,
  { signature: string; dispose: () => void }
>();
export const useExtensions = create<{
  installed: InstalledExtension[];
  error: string;
  loading: boolean;
}>(() => ({ installed: [], error: '', loading: false }));
let pending: Promise<void> | undefined;
function syncPanels(installed: InstalledExtension[]) {
  const developerMode = useUiStore.getState().developerMode;
  if (!developerMode) {
    const workspace = useWorkspaceStore.getState();
    for (const tab of workspace.tabs)
      if (tab.panelId?.startsWith('kubiki.sdk-test.')) workspace.closeTab(tab.id);
  }
  const wanted = new Set<string>();
  for (const extension of installed)
    for (const panel of extension.manifest.contributes.panels) {
      const id = `${extension.manifest.id}.${panel.id}`;
      if (!extension.enabled || !extensionVisible(extension, developerMode)) continue;
      wanted.add(id);
      const signature = JSON.stringify([extension.manifest.version, panel]);
      if (registrations.get(id)?.signature === signature) continue;
      registrations.get(id)?.dispose();
      const dispose = registerWorkspacePanel({
        id,
        title: panel.title,
        icon: (extension.manifest.id === 'kubiki.redis'
          ? RedisIcon
          : extension.manifest.id === 'kubiki.kafka'
            ? KafkaIcon
            : Puzzle) as unknown as LucideIcon,
        context: 'global',
        component: ({ visible }) => (
          <ExtensionPanel extensionId={extension.manifest.id} panelId={panel.id} visible={visible} />
        ),
      });
      registrations.set(id, { signature, dispose });
    }
  for (const [id, entry] of registrations)
    if (!wanted.has(id)) {
      entry.dispose();
      registrations.delete(id);
    }
}
useUiStore.subscribe((state, previous) => {
  if (state.developerMode !== previous.developerMode) syncPanels(useExtensions.getState().installed);
});

export function refreshExtensions(): Promise<void> {
  if (pending) return pending;
  useExtensions.setState({ loading: true });
  pending = extensionRequest<InstalledExtension[]>('list')
    .then((installed) => {
      syncPanels(installed);
      useExtensions.setState({ installed, error: '' });
    })
    .catch((e) => {
      useExtensions.setState({ error: e.message });
    })
    .finally(() => {
      pending = undefined;
      useExtensions.setState({ loading: false });
    });
  return pending;
}
