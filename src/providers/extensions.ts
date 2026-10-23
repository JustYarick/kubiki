import type { ExtensionManifest, Json } from '@kubiki/extension-sdk';
export interface InstalledExtension {
  manifest: ExtensionManifest;
  version: string;
  previous: string | null;
  enabled: boolean;
  origin: { type: 'builtin' | 'github' | 'local'; repo?: string };
  digest: string;
  status: 'enabled' | 'disabled' | 'running' | 'failed';
  error: string | null;
}
export interface ExtensionPreview {
  token: string;
  manifest: ExtensionManifest;
  source: InstalledExtension['origin'];
  tag: string | null;
  digest: string;
}
export const desktopExtensions = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export async function extensionRequest<T>(
  method: string,
  params: unknown = {},
  signal?: AbortSignal,
): Promise<T> {
  if (!desktopExtensions())
    throw new Error(
      'Extensions run in the desktop application. Open Kubiki desktop to install or run extensions.',
    );
  const { invoke } = await import('@tauri-apps/api/core');
  const id = crypto.randomUUID();
  if (signal?.aborted) throw new Error('Request cancelled');
  const cancel = () => {
    void invoke('extension_cancel', { id }).catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await invoke<T>('extension_request', { id, method, params });
  } catch (error) {
    throw new Error(
      typeof error === 'string'
        ? error
        : error instanceof Error
          ? error.message
          : 'Extension request failed',
    );
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
export type ExtensionJson = Json;
