import type { KubeContextInfo, ResourceItem, ResourceKind } from '../types/k8s';
import { mapK8sResourceList } from '../core/utils/k8s_mapper';
import { buildMockResources, MOCK_NAMESPACES } from './mock/mock_resources';

export const FALLBACK_CONTEXTS: KubeContextInfo[] = [
  { name: 'default', cluster: 'default', user: 'default', namespace: null, is_current: true },
  { name: 'minikube', cluster: 'minikube-local', user: 'developer', namespace: 'default', is_current: false },
  { name: 'staging-us-east', cluster: 'k8s-staging', user: 'developer', namespace: 'backend', is_current: false },
  { name: 'prod-europe-west', cluster: 'k8s-prod', user: 'deployer', namespace: 'frontend', is_current: false },
];

export class K8sProvider {
  private isTauriEnv(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  async getContexts(): Promise<KubeContextInfo[]> {
    if (this.isTauriEnv()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const list = await invoke<KubeContextInfo[]>('get_kube_contexts');
        if (list && list.length > 0) return list;
      } catch (err) {
        console.warn('Tauri get_kube_contexts error:', err);
      }
    }

    try {
      const res = await fetch('/api/k8s/contexts');
      if (res.ok) {
        const list = await res.json();
        if (Array.isArray(list) && list.length > 0) return list;
      }
    } catch {
      // In standalone browser mode without dev server middleware
    }

    return FALLBACK_CONTEXTS;
  }

  async pingCluster(context: string): Promise<{ status: string; version?: string }> {
    if (this.isTauriEnv()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const ver = await invoke<any>('ping_cluster', { context });
        const v = ver?.git_version || (ver?.major ? `v${ver.major}.${ver.minor}` : '1.35.5');
        return { status: 'connected', version: v };
      } catch (err: any) {
        console.warn('Tauri ping_cluster error:', err);
        return { status: 'error', version: undefined };
      }
    }

    try {
      const res = await fetch(`/api/k8s/ping?context=${encodeURIComponent(context)}`);
      if (res.ok) {
        const data = await res.json();
        const v = data.version?.gitVersion || data.version?.git_version || 'v1.35.5';
        return { status: 'connected', version: v };
      }
    } catch {
      // Ignore
    }

    return { status: 'connected', version: '1.35.5' };
  }

  async getNamespaces(context: string): Promise<string[]> {
    if (this.isTauriEnv()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const list = await invoke<string[]>('get_namespaces', { context });
        if (list && list.length > 0) return list;
      } catch (err) {
        console.warn('Tauri get_namespaces error:', err);
      }
    }

    try {
      const res = await fetch(`/api/k8s/namespaces?context=${encodeURIComponent(context)}`);
      if (res.ok) {
        const list = await res.json();
        if (Array.isArray(list) && list.length > 0) return list;
      }
    } catch {
      // Ignore
    }

    return MOCK_NAMESPACES;
  }

  async getResources(context: string, kind: ResourceKind, namespace?: string): Promise<ResourceItem[]> {
    if (this.isTauriEnv()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const rawJson = await invoke<any>('get_resources', {
          context,
          kind,
          namespace: namespace && namespace !== 'all' ? namespace : null,
        });
        return mapK8sResourceList(rawJson, kind);
      } catch (err) {
        console.warn(`Tauri get_resources(${kind}) error:`, err);
      }
    }

    try {
      const nsParam = namespace && namespace !== 'all' ? `&namespace=${encodeURIComponent(namespace)}` : '';
      const res = await fetch(`/api/k8s/resources?kind=${kind}&context=${encodeURIComponent(context)}${nsParam}`);
      if (res.ok) {
        const rawJson = await res.json();
        return mapK8sResourceList(rawJson, kind);
      }
    } catch {
      // Ignore
    }

    // Fallback to mock resources if cluster cannot be queried
    const mock = buildMockResources();
    return mock[kind] || [];
  }

  async scaleWorkload(
    context: string,
    kind: string,
    name: string,
    namespace: string,
    replicas: number
  ): Promise<boolean> {
    if (this.isTauriEnv()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('scale_workload', { context, kind, name, namespace, replicas });
        return true;
      } catch (err) {
        console.warn('Tauri scale_workload error:', err);
        return false;
      }
    }

    try {
      const res = await fetch('/api/k8s/scale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context, kind, name, namespace, replicas }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export const k8s = new K8sProvider();
