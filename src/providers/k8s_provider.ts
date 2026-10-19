import type { KubeContextInfo, ResourceItem, ResourceKind } from '../types/k8s';
import { mapK8sResourceList } from '../core/utils/k8s_mapper';
import { buildMockResources, MOCK_NAMESPACES } from './mock/mock_resources';

export const DEMO_CONTEXT = 'kubiki-demo';

export class K8sProvider {
  readonly demo = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === '1';
  private mock: ReturnType<typeof buildMockResources> | undefined;

  private isTauriEnv(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  private async request<T>(command: string, path: string, args: Record<string, unknown> = {}, body?: unknown): Promise<T> {
    if (this.isTauriEnv()) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<T>(command, args);
    }
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) if (value != null) query.set(key, String(value));
    const response = await fetch(`/api/k8s/${path}?${query}`, body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => { throw new Error('Kubernetes bridge unavailable. Start the desktop app or development server; use ?demo=1 for a demo.'); });
    if (!response.ok) throw new Error(data.error || `Kubernetes request failed (${response.status})`);
    return data as T;
  }

  async getContexts(): Promise<KubeContextInfo[]> {
    if (this.demo) return [{ name: DEMO_CONTEXT, cluster: 'Demo cluster', user: 'demo', is_current: true }];
    return this.request('get_kube_contexts', 'contexts');
  }

  async pingCluster(context: string): Promise<{ status: string; version?: string }> {
    if (this.demo) return { status: 'demo' };
    const data = await this.request<any>('ping_cluster', 'ping', { context });
    const version = data.version ?? data;
    return { status: 'connected', version: version.gitVersion ?? version.git_version };
  }

  async getNamespaces(context: string): Promise<string[]> {
    if (this.demo) return MOCK_NAMESPACES;
    return this.request('get_namespaces', 'namespaces', { context });
  }

  async getResources(context: string, kind: ResourceKind, namespace?: string): Promise<ResourceItem[]> {
    if (this.demo) {
      this.mock ??= buildMockResources();
      return (this.mock[kind] ?? []).filter((item) => !namespace || namespace === 'all' || !item.namespace || item.namespace === namespace);
    }
    const raw = await this.request('get_resources', 'resources', { context, kind, namespace: namespace && namespace !== 'all' ? namespace : null });
    return mapK8sResourceList(raw, kind);
  }

  async getLogs(context: string, name: string, namespace: string, container?: string): Promise<string> {
    if (this.demo) return '';
    return this.request('get_pod_logs', 'logs', { context, name, namespace, container });
  }

  async scaleWorkload(context: string, kind: string, name: string, namespace: string, replicas: number): Promise<boolean> {
    if (this.demo) return true;
    const args = { context, kind, name, namespace, replicas };
    await this.request('scale_workload', 'scale', args, args);
    return true;
  }
}

export const k8s = new K8sProvider();
