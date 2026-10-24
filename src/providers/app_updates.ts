import type { UpdateAdapter, UpdateCheck, UpdatePreferences, UpdateProgress } from '../core/app_updates';

export const desktopUpdateAdapter: UpdateAdapter = {
  async check() {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
      return { status: 'disabled', reason: 'In-app updates are available in the desktop application.' };
    }
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<UpdateCheck>('check_app_update');
  },
  async download(version, progress) {
    const { invoke, Channel } = await import('@tauri-apps/api/core');
    const onProgress = new Channel<UpdateProgress>();
    onProgress.onmessage = progress;
    try {
      await invoke('download_app_update', { version, onProgress });
    } finally {
      onProgress.onmessage = () => {};
      const internals = (window as unknown as { __TAURI_INTERNALS__?: { unregisterCallback?: (id: number) => void } }).__TAURI_INTERNALS__;
      internals?.unregisterCallback?.(onProgress.id);
    }
  },
  async install(version) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('install_app_update', { version });
  },
};

const PREFERENCES_KEY = 'kubiki.app-updates.v1';
export const updatePreferences = {
  read(): UpdatePreferences {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}');
      if (!value || typeof value !== 'object') return {};
      const entry = value as Record<string, unknown>;
      return {
        skippedVersion: typeof entry.skippedVersion === 'string' ? entry.skippedVersion : undefined,
        remindAfter: typeof entry.remindAfter === 'number' && Number.isFinite(entry.remindAfter) ? entry.remindAfter : undefined,
      };
    } catch { return {}; }
  },
  write(value: UpdatePreferences) {
    try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(value)); } catch { /* optional preferences */ }
  },
};
