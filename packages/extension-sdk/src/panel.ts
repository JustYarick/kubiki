import type { Json } from './index';
export interface PanelHost {
  call<T extends Json = Json>(
    method: string,
    params?: Json,
    signal?: AbortSignal,
  ): Promise<T>;
  settings: {
    get(key: string): Promise<Json>;
    set(key: string, value: Json): Promise<void>;
  };
  notify(message: string): Promise<void>;
  onVisibility(callback: (visible: boolean) => void): () => void;
  dispose(): void;
}
/** The host owns the channel and extension identity. No Tauri APIs enter this frame. */
export function connectPanel(): Promise<PanelHost> {
  return new Promise((resolve) => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== parent ||
        event.data?.type !== 'kubiki:init' ||
        !event.ports[0]
      )
        return;
      window.removeEventListener('message', receive);
      const port = event.ports[0];
      let next = 0;
      let closed = false;
      const listeners = new Set<(visible: boolean) => void>();
      const pending = new Map<
        number,
        {
          resolve(value: Json): void;
          reject(error: Error): void;
          cleanup(): void;
        }
      >();
      const theme = (tokens: Record<string, string>) => {
        for (const [key, value] of Object.entries(tokens))
          if (
            /^--[a-z-]+$/.test(key) &&
            typeof value === 'string' &&
            value.length < 150
          )
            document.documentElement.style.setProperty(key, value);
      };
      theme(event.data.theme ?? {});
      port.onmessage = ({ data }) => {
        if (data?.type === 'theme') {
          theme(data.tokens);
          return;
        }
        if (data?.type === 'visibility') {
          listeners.forEach((callback) => callback(data.visible));
          return;
        }
        const request = pending.get(data?.id);
        if (!request) return;
        pending.delete(data.id);
        request.cleanup();
        if (data.error) request.reject(new Error(String(data.error)));
        else request.resolve(data.result ?? null);
      };
      const request = <T extends Json = Json>(
        method: string,
        params: Json = null,
        signal?: AbortSignal,
      ): Promise<T> =>
        new Promise((yes, no) => {
          if (closed || signal?.aborted) {
            no(new Error('Request cancelled'));
            return;
          }
          const id = ++next;
          const abort = () => {
            pending.delete(id);
            cleanup();
            port.postMessage({ type: 'cancel', id });
            no(new Error('Request cancelled'));
          };
          const timer = setTimeout(abort, 30000);
          const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
          };
          signal?.addEventListener('abort', abort, { once: true });
          pending.set(id, {
            resolve: (value) => yes(value as T),
            reject: no,
            cleanup,
          });
          port.postMessage({ id, method, params });
        });
      const host: PanelHost = {
        call: (method, params, signal) =>
          request('call', { method, params: params ?? null }, signal),
        settings: {
          get: (key) => request('settings.get', { key }),
          set: async (key, value) => {
            await request('settings.set', { key, value });
          },
        },
        notify: async (message) => {
          await request('notify', { message });
        },
        onVisibility: (callback) => {
          listeners.add(callback);
          callback(event.data.visible !== false);
          return () => {
            listeners.delete(callback);
          };
        },
        dispose: () => {
          if (closed) return;
          closed = true;
          for (const p of pending.values()) {
            p.cleanup();
            p.reject(new Error('Panel closed'));
          }
          pending.clear();
          listeners.clear();
          port.close();
        },
      };
      window.addEventListener('pagehide', () => host.dispose(), { once: true });
      resolve(host);
    };
    window.addEventListener('message', receive);
  });
}
