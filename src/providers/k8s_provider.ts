import { environmentReadTransport, type KubernetesReadTransport } from './read_transport';
import { queuedRead } from './read_queue';
import { applyBatch as applyBatchRequest, changeResource, deleteObject, type BatchResult, type BatchStep } from './mutations';
import { resourceRef } from '../core/resources/identity';
import { namespaceNames, inNamespaceScope } from '../core/resources/namespace_scope';
import { parseApiResources } from './api_discovery';
import { RESOURCE_TYPES } from '../core/resources/resource_types';
import { pollResourceSnapshots } from './snapshot_watch';
import { watchNamespaceSelection } from './multi_namespace_watch';
import type { KubeContextInfo, ResourceItem, ResourceKind } from '../types/k8s';
import { mapK8sResourceList } from '../core/utils/k8s_mapper';
import { buildMockResources, MOCK_NAMESPACES } from './mock/mock_resources';
import { buildMockMetrics } from './mock/mock_metrics';
import { parseApiVersion, resourceQuery, resourceType } from '../core/resources/resource_types';
import type { KubernetesProvider } from './contract';
import { normalizeK8sError, requestError, type RequestInfo } from './errors';
import type { ResourceQuery, ResourceRef } from '../core/resources/resource_types';
import type { WatchBatch } from './watch_types';
import { parseCustomResources, type CustomResourceInstance } from './custom_resources';
import { resourceBucket } from '../core/resources/custom_resource_types';
import { parseHelmReleases, parseHelmHistory, parseHelmRepositories, validateHelmTarget, validateHelmDocument, type HelmDocument } from './helm_types';

export const DEMO_CONTEXT = 'kubiki-demo';

export class K8sProvider implements KubernetesProvider {
  readonly managesInitialSyncTimeout = true;
  constructor(private readonly transport: KubernetesReadTransport = environmentReadTransport, private developerMode = false) {}
  private readonly forcedDemo = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === '1';
  private activeContext: string | null = null;
  private contextReads = new AbortController();
  private demoListed = false;
  private realContexts: KubeContextInfo[] | null = null;
  get demo(): boolean { return this.forcedDemo || this.demoListed && this.activeContext === DEMO_CONTEXT; }
  // Only the explicit browser demo simulates the workstation's own shell.
  get simulateHostSessions(): boolean { return this.forcedDemo; }
  activateContext(context: string) {
    if (context !== this.activeContext) { this.contextReads.abort(); this.contextReads = new AbortController(); }
    this.activeContext = context;
  }
  setDeveloperMode(enabled: boolean): KubeContextInfo[] | null {
    this.developerMode = enabled;
    return this.realContexts ? this.contextList(this.realContexts) : null;
  }
  private contextList(contexts: KubeContextInfo[]): KubeContextInfo[] {
    this.demoListed = (!contexts.length || this.developerMode) && !contexts.some(context => context.name === DEMO_CONTEXT);
    return this.demoListed ? [...contexts, { name: DEMO_CONTEXT, cluster: 'Demo cluster', user: 'demo', is_current: contexts.length === 0 }] : contexts;
  }
  private mock: ReturnType<typeof buildMockResources> | undefined;
  get supportsResourceWatch(): boolean { return !this.demo && this.isTauriEnv(); }
  get supportsHelmMutations(): boolean { return !this.demo && this.isTauriEnv(); }

  async resetResourceWatches(): Promise<void> {
    if (!this.isTauriEnv()) return;
    const { invoke } = await import('@tauri-apps/api/core');
    try { await invoke('stop_resource_watches'); }
    catch (error) { throw normalizeK8sError(error, { operation: 'unwatch' }); }
  }

  async watchResources(query: ResourceQuery, onBatch: (batch: WatchBatch) => void, signal: AbortSignal): Promise<() => void> {
    if (!this.supportsResourceWatch) throw requestError('unsupported', 'Resource watch is available in the desktop app. Browser mode uses snapshots.', { operation: 'watch', context: query.context, resource: query });
    if (resourceType(query.kind).watch === false) return watchNamespaceSelection({ watchResources: (scoped, receive, abort) => pollResourceSnapshots(scoped, () => this.request('get_resources', 'resources', { ...scoped }, undefined, undefined, abort), receive, abort) }, query, onBatch, signal);
    const { watchTauriResources } = await import('./tauri_watch');
    return watchNamespaceSelection({ watchResources: watchTauriResources }, query, onBatch, signal);
  }

  private isTauriEnv(): boolean {
    return this.transport.native;
  }

  private async request<T>(command: string, path: string, args: Record<string, unknown> = {}, body?: unknown, nativeArgs?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const info: RequestInfo = { operation: path, context: args.context as string | undefined,
      resource: args.kind ? { context: args.context as string, group: args.group as string ?? '', version: args.version as string ?? 'v1', kind: args.kind as string, namespace: args.namespace as string ?? null,
        ...(args.name ? { name: args.name as string, uid: null } : {}) } : undefined };
    const controller = new AbortController();
    const sources = [signal, args.context && args.context === this.activeContext ? this.contextReads.signal : undefined].filter((source): source is AbortSignal => !!source);
    const abort = () => controller.abort();
    for (const source of sources) { source.addEventListener('abort', abort, { once: true }); if (source.aborted) abort(); }
    try {
      if (path !== 'contexts' && path !== 'kubeconfig_path' && path !== 'set_kubeconfig_path' && path !== 'helm/repositories' && path !== 'helm/charts' && !(args.context as string | undefined)?.trim()) throw requestError('invalid_request', 'A Kubernetes context is required', info, 400);
      return await queuedRead(() => this.transport.request<T>(command, path, this.transport.native ? nativeArgs ?? args : args, info, body, controller.signal), controller.signal);
    } catch (error) { throw normalizeK8sError(error, info); }
    finally { for (const source of sources) source.removeEventListener('abort', abort); }
  }

  async getContexts(): Promise<KubeContextInfo[]> {
    if (this.forcedDemo) return [{ name: DEMO_CONTEXT, cluster: 'Demo cluster', user: 'demo', is_current: true }];
    let contexts: KubeContextInfo[];
    try { contexts = await this.request('get_kube_contexts', 'contexts'); }
    catch (error) {
      const message = normalizeK8sError(error).message;
      const missingConfig = /(?:kubeconfig|config).*?(?:not found|no such file|does not exist|not set)|(?:no such file|not found).*?(?:kubeconfig|config)/i.test(message);
      if (!this.developerMode && !missingConfig) throw error;
      contexts = [];
    }
    this.realContexts = contexts;
    return this.contextList(contexts);
  }

  async getKubeconfigPath(): Promise<string> {
    if (this.forcedDemo) return '~/.kube/config (demo)';
    return this.request('get_kubeconfig_path', 'kubeconfig_path');
  }

  async setKubeconfigPath(path: string | null): Promise<KubeContextInfo[]> {
    if (this.forcedDemo) return this.getContexts();
    await this.request('set_kubeconfig_path', 'set_kubeconfig_path', { path });
    return this.getContexts();
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

  async getApiResources(context: string) {
    if (this.demo) return [...RESOURCE_TYPES];
    return parseApiResources(await this.request('get_api_resources', 'api-resources', { context }));
  }

  async getResources(context: string, kind: ResourceKind, namespace?: string, signal?: AbortSignal): Promise<ResourceItem[]> {
    if (this.demo) {
      this.mock ??= buildMockResources();
      return (this.mock[kind] ?? []).filter((item) => inNamespaceScope(namespace ?? 'all', item.namespace));
    }
    const names = namespaceNames(namespace ?? 'all');
    if (names && names.length !== 1 && resourceType(kind).namespaced) return (await Promise.all(names.map(name => this.getResources(context, kind, name, signal)))).flat();
    const query = resourceQuery(context, kind, namespace);
    const raw = await this.request<any>('get_resources', 'resources', { ...query }, undefined, undefined, signal);
    if (!raw || !Array.isArray(raw.items) || raw.items.some((item: any) => !item || typeof item.metadata?.name !== 'string' || !item.metadata.name || item.kind && item.kind !== kind || item.apiVersion && (typeof item.apiVersion !== 'string' || parseApiVersion(item.apiVersion).group !== query.group))) {
      throw requestError('internal', 'Invalid resource list returned by Kubernetes bridge', { operation: 'resources', context, resource: query });
    }
    return mapK8sResourceList(raw, kind);
  }

  async getResourceCounts(context: string, kinds: ResourceKind[], namespace?: string, signal?: AbortSignal): Promise<Partial<Record<ResourceKind, number>>> {
    if (this.demo) {
      this.mock ??= buildMockResources();
      const counts: Partial<Record<ResourceKind, number>> = {};
      for (const kind of kinds) {
        const items = this.mock[kind];
        if (!items) continue;
        counts[kind] = items.filter((item) => inNamespaceScope(namespace ?? 'all', item.namespace)).length;
      }
      return counts;
    }
    const builtinKinds = kinds.filter(kind => !kind.startsWith('custom:'));
    if (!builtinKinds.length) return {};
    const names = namespaceNames(namespace ?? 'all');
    if (names && names.length !== 1 && !this.isTauriEnv()) {
      const namespaced = builtinKinds.filter(kind => resourceType(kind).namespaced);
      const clusterKinds = builtinKinds.filter(kind => !resourceType(kind).namespaced);
      const [cluster, ...slices] = await Promise.all([
        this.getResourceCounts(context, clusterKinds, undefined, signal),
        ...names.map(name => this.getResourceCounts(context, namespaced, name, signal)),
      ]);
      const totals: Partial<Record<ResourceKind, number>> = { ...cluster };
      for (const kind of namespaced) {
        const counts = slices.map(slice => slice[kind]);
        if (counts.every((count): count is number => typeof count === 'number')) totals[kind] = counts.reduce((sum, count) => sum + count, 0);
      }
      return totals;
    }
    const queries: ResourceQuery[] = [];
    for (const kind of builtinKinds) {
      const type = resourceType(kind);
      if (names && names.length !== 1 && type.namespaced) {
        for (const name of names) {
          queries.push(resourceQuery(context, kind, name));
        }
      } else {
        queries.push(resourceQuery(context, kind, names ? names[0] : namespace));
      }
    }
    const singleNamespace = names ? names[0] : namespace && namespace !== 'all' ? namespace : undefined;
    try {
      const raw = await this.request<Record<string, unknown>>(
        'get_resource_counts',
        'resource-counts',
        { context, ...(singleNamespace ? { namespace: singleNamespace } : {}), kinds: builtinKinds.join(',') },
        undefined,
        { context, queries },
        signal,
      );
      const counts: Partial<Record<ResourceKind, number>> = {};
      for (const [kind, count] of Object.entries(raw ?? {})) {
        if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
          counts[kind as ResourceKind] = count;
        }
      }
      return counts;
    } catch {
      return {};
    }
  }

  async getLogs(context: string, name: string, namespace: string, container?: string): Promise<string> {
    if (this.demo) return '';
    return this.request('get_pod_logs', 'logs', { ...resourceQuery(context, 'Pod', namespace), name, container });
  }

  async getCustomResources(context: string, name: string, uid: string, namespace: string | null, signal?: AbortSignal): Promise<CustomResourceInstance[]> {
    const names = namespaceNames(namespace ?? 'all');
    if (names && names.length !== 1) return (await Promise.all(names.map(namespace => this.getCustomResources(context, name, uid, namespace, signal)))).flat();
    if (this.demo) {
      if (name === 'buckets.source.toolkit.fluxcd.io') {
        const rawItems = [
          {
            apiVersion: 'source.toolkit.fluxcd.io/v1beta2',
            kind: 'Bucket',
            metadata: { name: 'media-assets', namespace: 'default', uid: 'bucket-media-1', creationTimestamp: new Date(Date.now() - 86400000 * 5).toISOString() },
            spec: { endpoint: 's3.eu-west-1.amazonaws.com', bucketName: 'media-assets-prod', interval: '5m' },
            status: { conditions: [{ type: 'Ready', status: 'True', message: 'Stored revision: v1.2.0' }] },
          },
          {
            apiVersion: 'source.toolkit.fluxcd.io/v1beta2',
            kind: 'Bucket',
            metadata: { name: 'backup-dumps', namespace: 'infra', uid: 'bucket-backup-2', creationTimestamp: new Date(Date.now() - 86400000 * 12).toISOString() },
            spec: { endpoint: 'minio.infra.svc.cluster.local:9000', bucketName: 'backups', interval: '10m' },
            status: { conditions: [{ type: 'Ready', status: 'True', message: 'Stored revision: rev-381' }] },
          },
        ];
        return parseCustomResources({ items: rawItems }).filter(item => inNamespaceScope(namespace ?? 'all', item.namespace));
      }
      this.mock ??= buildMockResources();
      const definition = this.mock.CustomResourceDefinition.find(item => item.name === name);
      const spec = definition?.raw?.spec;
      return spec ? (this.mock[resourceBucket({ kind: spec.names.kind, apiVersion: `${spec.group}/${spec.versions.find((version: any) => version.storage)?.name ?? 'v1'}` })] ?? []).filter(item => inNamespaceScope(namespace ?? 'all', item.namespace)) : [];
    }
    return parseCustomResources(await this.request('get_custom_resources', 'custom-resources', { context, name, uid, namespace }, undefined, undefined, signal));
  }

  async getOverviewMetrics(context: string, namespace: string | null, signal?: AbortSignal): Promise<import('./overview_metrics').OverviewMetrics> {
    const { validateMetrics } = await import('./overview_metrics');
    const names = namespaceNames(namespace ?? 'all');
    if (names && names.length !== 1) {
      const metrics = await Promise.all(names.map(namespace => this.getOverviewMetrics(context, namespace, signal)));
      const error = metrics.find(result => result.pods.error)?.pods.error ?? null;
      return { context, namespace, pods: { items: error ? null : metrics.flatMap(result => result.pods.items ?? []), error }, nodes: { items: null, error: null } };
    }
    if (this.demo) {
      this.mock ??= buildMockResources();
      return buildMockMetrics(this.mock, context, namespace);
    }
    return validateMetrics(await this.request('get_overview_metrics', 'metrics', { context, namespace }, undefined, undefined, signal), context, namespace);
  }

  async updateSecretData(request: import('./secret_data').SecretDataRequest): Promise<Record<string, any>> {
    if (this.demo) throw new Error('Demo updates are handled in memory');
    return changeResource({ operation: 'secret', request });
  }

  async getHelmInventory(context: string, namespace: string | null, signal?: AbortSignal): Promise<import('./helm_types').HelmRelease[]> {
    validateHelmTarget(context, namespace);
    if (this.demo) {
      const { demoHelmInventory } = await import('./mock/mock_helm');
      return demoHelmInventory(namespace);
    }
    const items = parseHelmReleases(await this.request('get_helm_inventory', 'helm/inventory', { context, namespace }, undefined, undefined, signal));
    if (namespace && items.some(item => item.namespace !== namespace)) throw requestError('internal', 'Helm returned releases outside the requested namespace', { operation: 'helm', context }, 500);
    return items;
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

  async searchHelmCharts(query: string): Promise<import('./helm_types').HelmChart[]> {
    if (this.demo) return [];
    const charts = await this.request<unknown>('search_helm_charts', 'helm/charts', { query });
    if (!Array.isArray(charts) || charts.some(chart => !chart || ['name', 'version', 'app_version', 'description'].some(key => typeof chart[key] !== 'string'))) throw requestError('internal', 'Invalid Helm chart response', { operation: 'helm' });
    return charts;
  }

  async mutateHelm(request: import('./helm_types').HelmMutation): Promise<{ message: string }> {
    if (!this.supportsHelmMutations) throw requestError('forbidden', 'Helm changes require the desktop app and backend system confirmation.', { operation: 'helm_mutation' }, 403);
    return changeResource({ operation: 'helm', request });
  }

  async scaleWorkload(context: string, kind: string, name: string, namespace: string, replicas: number, uid: string, resourceVersion: string): Promise<boolean> {
    if (this.demo) return true;
    if (!['Deployment', 'StatefulSet', 'ReplicaSet'].includes(kind)) throw requestError('unsupported', 'Only Deployment, StatefulSet and ReplicaSet can be scaled', { context, operation: 'scale' }, 400);
    const resource = { ...resourceQuery(context, kind as ResourceKind, namespace), name, uid };
    await changeResource({ operation: 'scale', resource, resource_version: resourceVersion, replicas });
    return true;
  }

  async applyManifest(context: string, manifest: string, item?: ResourceItem): Promise<string> {
    if (this.demo) return 'Manifest applied in demo memory';
    const target = item ? { resource: resourceRef(context, item), resource_version: item.raw?.metadata?.resourceVersion ?? '' } : undefined;
    await changeResource({ operation: 'manifest', context, manifest, ...(target ? { target } : {}) });
    return 'Manifest saved';
  }

  async deleteResource(context: string, kind: string, name: string, namespace: string | undefined, uid: string, resourceVersion: string, apiVersion?: string): Promise<string> {
    if (this.demo) return 'Resource deleted in demo memory';
    const resource = apiVersion ? { context, ...parseApiVersion(apiVersion), kind, namespace: namespace ?? null, name, uid } : { ...resourceQuery(context, kind as ResourceKind, namespace), name, uid };
    await deleteObject({ operation: 'resource', resource, resource_version: resourceVersion });
    return 'Resource deleted';
  }

  async evictPod(context: string, name: string, namespace: string, uid: string, resourceVersion: string): Promise<string> {
    if (this.demo) return 'Pod evicted (demo)';
    const resource = { ...resourceQuery(context, 'Pod', namespace), name, uid };
    await changeResource({
      operation: 'evict',
      resource,
      resource_version: resourceVersion,
    });
    return 'Pod evicted';
  }

  async applyBatch(primary: ResourceRef, steps: BatchStep[]): Promise<BatchResult> {
    return applyBatchRequest(primary, steps);
  }
}

export const k8s = new K8sProvider();
