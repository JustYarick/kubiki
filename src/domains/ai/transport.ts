import type { AgentEvent, AgentMode, AgentScope, AiSettings, GenerationOptions, ModelInfo, SessionView, SettingsView } from './types';

export function desktopAiAvailable(): boolean { return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window; }
export function agentError(error: unknown): string {
  return typeof error === 'string' ? error : error instanceof Error ? error.message : 'The AI request failed. Check the connection and settings.';
}
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!desktopAiAvailable()) throw new Error('AI connections and cluster tools are available in the desktop app.');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}
export const agentTransport = {
  settings: () => invoke<SettingsView>('ai_get_settings'),
  save: (settings: AiSettings) => invoke<void>('ai_save_settings', { settings }),
  credential: (providerId: string, apiKey: string | null) => invoke<void>('ai_set_credential', { providerId, apiKey }),
  models: (providerId: string, modelId?: string) => invoke<ModelInfo[]>('ai_list_models', { providerId, modelId }),
  create: (scope: AgentScope, providerId: string, model: string, options: GenerationOptions) => invoke<SessionView>('ai_create_session', { request: { scope, providerId, model, options } }),
  mode: (sessionId: string, mode: AgentMode) => invoke<void>('ai_set_mode', { sessionId, mode }),
  stop: (sessionId: string, close = false) => invoke<void>('ai_stop', { sessionId, close }),
  async send(sessionId: string, message: string, receive: (event: AgentEvent) => void): Promise<void> {
    if (!desktopAiAvailable()) throw new Error('Open the desktop app to send AI messages.');
    const { invoke, Channel } = await import('@tauri-apps/api/core');
    const onEvent = new Channel<AgentEvent>();
    let text = ''; let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => { if (timer) clearTimeout(timer); timer = undefined; if (text) { const value = text; text = ''; receive({ type: 'text_delta', text: value }); } };
    onEvent.onmessage = event => {
      if (event.type === 'text_delta') { text += event.text; timer ??= setTimeout(flush, 32); }
      else { flush(); receive(event); }
    };
    try { await invoke('ai_send_message', { sessionId, message, onEvent }); }
    finally {
      flush();
      onEvent.onmessage = () => {};
      const internals = (window as unknown as { __TAURI_INTERNALS__?: { unregisterCallback?: (id: number) => void } }).__TAURI_INTERNALS__;
      internals?.unregisterCallback?.(onEvent.id);
    }
  },
};
