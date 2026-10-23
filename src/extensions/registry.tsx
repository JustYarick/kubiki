import { Database, Puzzle } from 'lucide-react';
import { create } from 'zustand';
import {
  extensionRequest,
  type InstalledExtension,
} from '../providers/extensions';
import { registerWorkspacePanel } from '../core/workspace_panels';
import { ExtensionPanel } from './ExtensionPanel';
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
export function refreshExtensions(): Promise<void> {
  if (pending) return pending;
  useExtensions.setState({ loading: true });
  pending = extensionRequest<InstalledExtension[]>('list')
    .then((installed) => {
      const wanted = new Set<string>();
      for (const extension of installed)
        for (const panel of extension.manifest.contributes.panels) {
          const id = `${extension.manifest.id}.${panel.id}`;
          if (!extension.enabled) continue;
          wanted.add(id);
          const signature = JSON.stringify([extension.manifest.version, panel]);
          if (registrations.get(id)?.signature === signature) continue;
          registrations.get(id)?.dispose();
          const dispose = registerWorkspacePanel({
            id,
            title: panel.title,
            icon: extension.manifest.id === 'kubiki.redis' ? Database : Puzzle,
            context: 'global',
            component: ({ visible }) => (
              <ExtensionPanel
                extensionId={extension.manifest.id}
                panelId={panel.id}
                visible={visible}
              />
            ),
          });
          registrations.set(id, { signature, dispose });
        }
      for (const [id, entry] of registrations)
        if (!wanted.has(id)) {
          entry.dispose();
          registrations.delete(id);
        }
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
