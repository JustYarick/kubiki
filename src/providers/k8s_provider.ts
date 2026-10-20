import type { KubeContextInfo, ResourceItem, ResourceKind } from '../types/k8s';
import { mapK8sResourceList } from '../core/utils/k8s_mapper';
import { buildMockResources, MOCK_NAMESPACES } from './mock/mock_resources';
import { parseApiVersion, resourceQuery } from '../core/resources/resource_types';
import type { KubernetesProvider } from './contract';
import { normalizeK8sError, requestError, type RequestInfo } from './errors';
import type { ResourceQuery } from '../core/resources/resource_types';
import type { WatchBatch } from './watch_types';
import { parseHelmPage, parseHelmHistory, parseHelmRepositories, validateHelmTarget, validateHelmOffset, validateHelmDocument, type HelmDocument } from './helm_types';

export const DEMO_CONTEXT = 'kubiki-demo';

export class K8sProvider implements KubernetesProvider {
  readonly demo = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === '1';
  private mock: ReturnType<typeof buildMockResources> | undefined;
  get supportsResourceWatch(): boolean { return !this.demo && this.isTauriEnv(); }

  async resetResourceWatches(): Promise<void> {
    if (!this.supportsResourceWatch) return;
    const { invoke } = await import('@tauri-apps/api/core');
    try { await invoke('stop_resource_watches'); }
    catch (error) { throw normalizeK8sError(error, { operation: 'unwatch' }); }
  }

  async watchResources(query: ResourceQuery, onBatch: (batch: WatchBatch) => void, signal: AbortSignal): Promise<() => void> {
    if (!this.supportsResourceWatch) throw requestError('unsupported', 'Resource watch is available in the desktop app. Browser mode uses snapshots.', { operation: 'watch', context: query.context, resource: query });
    const { watchTauriResources } = await import('./tauri_watch');
    return watchTauriResources(query, onBatch, signal);
  }

  private isTauriEnv(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  private async request<T>(command: string, path: string, args: Record<string, unknown> = {}, body?: unknown, nativeArgs?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const info: RequestInfo = { operation: path, context: args.context as string | undefined,
      resource: args.kind ? { context: args.context as string, group: args.group as string ?? '', version: args.version as string ?? 'v1', kind: args.kind as string, namespace: args.namespace as string ?? null,
        ...(args.name ? { name: args.name as string, uid: null } : {}) } : undefined };
    try {
      if (path !== 'contexts' && path !== 'helm/repositories' && !(args.context as string | undefined)?.trim()) throw requestError('invalid_request', 'A Kubernetes context is required', info, 400);
      if (this.isTauriEnv()) {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<T>(command, nativeArgs ?? args);
      }
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
    } catch (error) { throw normalizeK8sError(error, info); }
  }

  async getContexts(): Promise<KubeContextInfo[]> {
    if (this.demo) return [{ name: DEMO_CONTEXT, cluster: 'Demo cluster', user: 'demo', is_current: true }];
    return this.request('get_kube_contexts', 'contexts');
  }

  async pingCluster(context: string): Promise<{ status: string; version?: string }> {
    if (this.demo) return { status: 'demo' };
    const data = await this.request<any>('ping_cluster', 'ping', { context });
    const version = data?.version ?? data;
    const gitVersion = version?.gitVersion ?? version?.git_version;
    if (typeof gitVersion !== 'string' || !gitVersion) throw requestError('internal', 'The API server did not return a valid version', { operation: 'ping', context });
    return { status: 'connected', version: gitVersion };
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
    const query = resourceQuery(context, kind, namespace);
    const raw = await this.request<any>('get_resources', 'resources', { ...query });
    if (!raw || !Array.isArray(raw.items) || raw.items.some((item: any) => !item || typeof item.metadata?.name !== 'string' || !item.metadata.name || item.kind && item.kind !== kind || item.apiVersion && (typeof item.apiVersion !== 'string' || parseApiVersion(item.apiVersion).group !== query.group))) {
      throw requestError('internal', 'Invalid resource list returned by Kubernetes bridge', { operation: 'resources', context, resource: query });
    }
    return mapK8sResourceList(raw, kind);
  }

  async getLogs(context: string, name: string, namespace: string, container?: string): Promise<string> {
    if (this.demo) return '';
    return this.request('get_pod_logs', 'logs', { ...resourceQuery(context, 'Pod', namespace), name, container });
  }

  async getOverviewMetrics(context: string, namespace: string | null, signal?: AbortSignal): Promise<import('./overview_metrics').OverviewMetrics> {
    const { validateMetrics } = await import('./overview_metrics');
    if (this.demo) {
      this.mock ??= buildMockResources();
      const timestamp = new Date().toISOString();
      const pods = (this.mock.Pod ?? []).filter(pod => (!namespace || pod.namespace === namespace) && !['Completed', 'Succeeded', 'Failed'].includes(pod.status ?? '')).map((pod, index) => ({ name: pod.name, namespace: pod.namespace!, timestamp, window: '15s', containers: (pod.containers?.length ? pod.containers : [{ name: 'app' }]).map((container, i) => ({ name: container.name, cpu: `${70 + ((index * 47 + i * 19 + Math.floor(Date.now() / 15000) % 17) % 700)}m`, memory: `${40 + (index * 37 + i * 17) % 600}Mi` })) }));
      const nodes = namespace ? null : (this.mock.Node ?? []).map((node, i) => ({ name: node.name, timestamp, window: '15s', cpu: `${1200 + i * 730}m`, memory: `${1600 + i * 800}Mi` }));
      return { context, namespace, pods: { items: pods, error: null }, nodes: { items: nodes, error: null } };
    }
    return validateMetrics(await this.request('get_overview_metrics', 'metrics', { context, namespace }, undefined, undefined, signal), context, namespace);
  }

  async updateSecretData(request: import('./secret_data').SecretDataRequest): Promise<Record<string, any>> {
    if (this.demo) throw new Error('Demo updates are handled in memory');
    return this.request('update_secret_data', 'secrets', { ...request.resource }, request, { request });
  }

  async getHelmReleases(context: string, namespace: string | null, offset = 0, signal?: AbortSignal) {
    validateHelmTarget(context, namespace); validateHelmOffset(offset);
    if (this.demo) {
      const { demoHelmPage } = await import('./mock/mock_helm');
      return demoHelmPage(context, namespace, offset);
    }
    return parseHelmPage(await this.request('list_helm_releases', 'helm/releases', { context, namespace, offset }, undefined, undefined, signal), context, namespace, offset);
  }

  async getHelmHistory(context: string, namespace: string, name: string, signal?: AbortSignal) {
    validateHelmTarget(context, namespace, name);
    if (this.demo) return (await import('./mock/mock_helm')).demoHelmHistory(name);
    return parseHelmHistory(await this.request('get_helm_history', 'helm/history', { context, namespace, name }, undefined, undefined, signal));
  }

  async getHelmContent(context: string, namespace: string, name: string, revision: number, document: HelmDocument, signal?: AbortSignal): Promise<string> {
    validateHelmTarget(context, namespace, name); validateHelmDocument(document, revision);
    if (this.demo) return (await import('./mock/mock_helm')).demoHelmContent(name, namespace, revision, document);
    const content = await this.request<unknown>('get_helm_content', 'helm/content', { context, namespace, name, revision, document }, undefined, undefined, signal);
    if (typeof content !== 'string') throw requestError('internal', 'Helm returned an invalid document', { operation: 'helm', context }, 500);
    return content;
  }

  async getHelmRepositories(signal?: AbortSignal) {
    if (this.demo) return [{ name: 'kubiki-demo', url: 'https://charts.example.com' }];
    return parseHelmRepositories(await this.request('list_helm_repositories', 'helm/repositories', {}, undefined, undefined, signal));
  }

  async scaleWorkload(context: string, kind: string, name: string, namespace: string, replicas: number, uid: string, resourceVersion: string): Promise<boolean> {
    if (this.demo) return true;
    if (!['Deployment', 'StatefulSet'].includes(kind)) throw requestError('unsupported', 'Only Deployment and StatefulSet can be scaled', { context, operation: 'scale' }, 400);
    const resource = { ...resourceQuery(context, kind as ResourceKind, namespace), name, uid };
    const args = { resource, resourceVersion, replicas };
    await this.request('scale_workload', 'scale', resource, args, args);
    return true;
  }
}

export const k8s = new K8sProvider();
