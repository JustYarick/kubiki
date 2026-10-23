import { normalizeK8sError, requestError, type RequestInfo } from './errors';
export interface KubernetesReadTransport {
  readonly native: boolean;
  request<T>(command: string, path: string, args: Record<string, unknown>, info: RequestInfo, body?: unknown, signal?: AbortSignal): Promise<T>;
}
export class TauriReadTransport implements KubernetesReadTransport {
  readonly native = true;
  async request<T>(command: string, _path: string, args: Record<string, unknown>, _info: RequestInfo, _body?: unknown, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw requestError('cancelled', 'Read was cancelled', _info);
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(command, args);
  }
}
export class HttpReadTransport implements KubernetesReadTransport {
  readonly native = false;
  async request<T>(_command: string, path: string, args: Record<string, unknown>, info: RequestInfo, body?: unknown, signal?: AbortSignal): Promise<T> {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(args)) if (value != null) query.set(key, String(value));
      let response: Response;
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 20000);
      try {
        // A signal also bounds reading the response body.
        response = await fetch(`/api/k8s/${path}?${query}`, { signal: controller.signal, ...(body === undefined ? {} : {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }) });
        let data: unknown;
        try { data = await response.json(); }
        catch {
          if (controller.signal.aborted) throw requestError('timeout', 'Kubernetes bridge request timed out', info, 504);
          throw requestError('bridge_unavailable', 'Kubernetes bridge unavailable. Start the desktop app or development server; use ?demo=1 for a demo.', info, response.status);
        }
        if (!response.ok) throw normalizeK8sError(data, info, response.status);
        return data as T;
      } catch (error) {
        if (controller.signal.aborted) throw requestError('timeout', 'Kubernetes bridge request timed out', info, 504);
        if (error instanceof TypeError) throw requestError('unavailable', error.message, info);
        throw error;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}
const tauri = new TauriReadTransport();
const http = new HttpReadTransport();
export const environmentReadTransport: KubernetesReadTransport = {
  get native() { return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window; },
  request<T>(command: string, path: string, args: Record<string, unknown>, info: RequestInfo, body?: unknown, signal?: AbortSignal) { return (this.native ? tauri : http).request<T>(command, path, args, info, body, signal); },
};
