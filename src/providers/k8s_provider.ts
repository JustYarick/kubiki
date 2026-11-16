import { environmentReadTransport, type KubernetesReadTransport } from './read_transport';
import { queuedRead, type ReadLane } from './read_queue';
import type { ReadPriority } from './initial_sync_queue';
import { applyBatch as applyBatchRequest, changeResource, deleteObject, type BatchResult, type BatchStep } from './mutations';
import { resourceRef } from '../core/resources/identity';
import { namespaceNames, inNamespaceScope, namespaceScopeCovers } from '../core/resources/namespace_scope';
import { useResourceStore } from '../state/resource_store';
import { parseApiResources } from './api_discovery';
import { RESOURCE_TYPES } from '../core/resources/resource_types';
import { pollResourceSnapshots } from './snapshot_watch';
import { watchNamespaceSelection } from './multi_namespace_watch';
import type { KubeContextInfo, ResourceItem, ResourceKind } from '../types/k8s';
import { mapK8sResource, mapK8sResourceList } from '../core/utils/k8s_mapper';
import { buildMockResources, MOCK_NAMESPACES } from './mock/mock_resources';
import { buildMockMetrics } from './mock/mock_metrics';
import { parseApiVersion, resourceQuery, resourceType } from '../core/resources/resource_types';
import type { KubernetesProvider, PartialNamespaceFailure, ReadResourceOptions } from './contract';
import { normalizeK8sError, requestError, type RequestInfo } from './errors';
import type { ResourceQuery, ResourceRef } from '../core/resources/resource_types';
import type { WatchBatch, WatchFilter } from './watch_types';
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
  get supportsSinglePodMetric(): boolean { return this.demo || this.isTauriEnv(); }
  get supportsCustomSearchInventory(): boolean { return !this.demo && this.isTauriEnv(); }
  get supportsHelmMutations(): boolean { return !this.demo && this.isTauriEnv(); }

  async resetResourceWatches(): Promise<void> {
    if (!this.isTauriEnv()) return;
    const { invoke } = await import('@tauri-apps/api/core');
    try { await invoke('stop_resource_watches'); }
    catch (error) { throw normalizeK8sError(error, { operation: 'unwatch' }); }
  }

  async watchResources(query: ResourceQuery, onBatch: (batch: WatchBatch) => void, signal: AbortSignal, filter?: WatchFilter): Promise<() => void> {
    if (!this.supportsResourceWatch) throw requestError('unsupported', 'Resource watch is available in the desktop app. Browser mode uses snapshots.', { operation: 'watch', context: query.context, resource: query });
    if (resourceType(query.kind).watch === false) return watchNamespaceSelection({ watchResources: (scoped, receive, abort) => pollResourceSnapshots(scoped, () => this.request('get_resources', 'resources', { ...scoped }, undefined, undefined, abort), receive, abort) }, query, onBatch, signal);
    const { watchTauriResources } = await import('./tauri_watch');
    return watchNamespaceSelection({ watchResources: (scoped, receive, abort, activeFilter) => watchTauriResources(scoped, receive, abort, undefined, activeFilter) }, query, onBatch, signal, filter);
  }

  async watchCustomResources(query: ResourceQuery, definition: {name: string; uid: string}, onBatch: (batch: WatchBatch) => void, signal: AbortSignal, filter?: WatchFilter): Promise<() => void> {
    if (!this.supportsResourceWatch) throw requestError('unsupported', 'Custom resource watch requires the desktop app', {operation:'watch', context:query.context, resource:query});
    const { watchTauriResources } = await import('./tauri_watch');
    return watchNamespaceSelection({watchResources:(scoped, receive, abort, activeFilter) => watchTauriResources(scoped, receive, abort, definition, activeFilter)}, query, onBatch, signal, filter);
  }

  private isTauriEnv(): boolean {
    return this.transport.native;
  }

  private async request<T>(command: string, path: string, args: Record<string, unknown> = {}, body?: unknown, nativeArgs?: Record<string, unknown>, signal?: AbortSignal, priority: ReadPriority = 'normal', lane: ReadLane = 'default'): Promise<T> {
    const info: RequestInfo = { operation: path, context: args.context as string | undefined,
      resource: args.kind ? { context: args.context as string, group: args.group as string ?? '', version: args.version as string ?? 'v1', kind: args.kind as string, namespace: args.namespace as string ?? null,
        ...(args.name ? { name: args.name as string, uid: null } : {}) } : undefined };
    const controller = new AbortController();
    const sources = [signal, args.context && args.context === this.activeContext ? this.contextReads.signal : undefined].filter((source): source is AbortSignal => !!source);
    const abort = () => controller.abort();
    for (const source of sources) { source.addEventListener('abort', abort, { once: true }); if (source.aborted) abort(); }
    try {
      if (path !== 'contexts' && path !== 'kubeconfig_path' && path !== 'set_kubeconfig_path' && path !== 'helm/repositories' && path !== 'helm/charts' && !(args.context as string | undefined)?.trim()) throw requestError('invalid_request', 'A Kubernetes context is required', info, 400);
      return await queuedRead(() => this.transport.request<T>(command, path, this.transport.native ? nativeArgs ?? args : args, info, body, controller.signal), controller.signal, priority, lane);
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

  private buildListOptions(options?: ReadResourceOptions) {
    if (!options) return { http: undefined, native: undefined };
    const clean: Record<string, unknown> = {};
    if (options.metadataOnly) clean.metadataOnly = true;
    if (options.labelSelector) clean.labelSelector = options.labelSelector;
    if (options.fieldSelector) clean.fieldSelector = options.fieldSelector;
    if (options.limit != null) clean.limit = options.limit;
    if (options.projection) clean.projection = options.projection;
    if (!Object.keys(clean).length) return { http: undefined, native: undefined };
    const http: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(clean)) http[k] = typeof v === 'boolean' || typeof v === 'number' ? String(v) : v;
    return { http, native: { options: clean } };
  }

  private async readNamespacesSettled<T>(
    names: string[],
    readOne: (namespace: string) => Promise<T[]>,
    signal?: AbortSignal,
    onPartialError?: (failures: PartialNamespaceFailure[]) => void,
  ): Promise<T[]> {
    const settled = await Promise.allSettled(names.map(readOne));
    const items: T[] = [];
    const failures: PartialNamespaceFailure[] = [];
    let firstReason: unknown;
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === 'fulfilled') {
        items.push(...result.value);
      } else {
        const normalized = normalizeK8sError(result.reason);
        if (signal?.aborted || normalized.code === 'cancelled') {
          throw result.reason;
        }
        if (failures.length === 0) firstReason = result.reason;
        failures.push({ namespace: names[i], error: normalized });
      }
    }
    if (failures.length === names.length && names.length > 0) {
      throw firstReason;
    }
    if (failures.length > 0) {
      onPartialError?.(failures);
    }
    return items;
  }

  async getResources(context: string, kind: ResourceKind, namespace?: string, signal?: AbortSignal, options?: ReadResourceOptions): Promise<ResourceItem[]> {
    if (this.demo) {
      this.mock ??= buildMockResources();
      return (this.mock[kind] ?? []).filter((item) => inNamespaceScope(namespace ?? 'all', item.namespace));
    }
    const names = namespaceNames(namespace ?? 'all');
    if (names && names.length !== 1 && resourceType(kind).namespaced) {
      return this.readNamespacesSettled(
        names,
        name => this.getResources(context, kind, name, signal, options),
        signal,
        options?.onPartialError,
      );
    }
    const query = resourceQuery(context, kind, namespace);
    const extra = this.buildListOptions(options);
    const httpArgs = extra.http ? { ...query, ...extra.http } : { ...query };
    const nativeArgs = extra.native ? { ...query, ...extra.native } : undefined;
    const raw = await this.request<any>('get_resources', 'resources', httpArgs, undefined, nativeArgs, signal, options?.priority ?? 'normal', options?.lane ?? 'default');
    if (!raw || !Array.isArray(raw.items) || raw.items.some((item: any) => !item || typeof item.metadata?.name !== 'string' || !item.metadata.name || item.kind && item.kind !== kind && !options?.metadataOnly || item.apiVersion && !options?.metadataOnly && (typeof item.apiVersion !== 'string' || parseApiVersion(item.apiVersion).group !== query.group))) {
      throw requestError('internal', 'Invalid resource list returned by Kubernetes bridge', { operation: 'resources', context, resource: query });
    }
    return mapK8sResourceList(raw, kind);
  }

  async getResource(context: string, kind: ResourceKind, name: string, namespace?: string, options?: { metadataOnly?: boolean; priority?: ReadPriority }, signal?: AbortSignal): Promise<ResourceItem> {
    if (this.demo) {
      this.mock ??= buildMockResources();
      const found = (this.mock[kind] ?? []).find(item => item.name === name && (!resourceType(kind).namespaced || item.namespace === namespace));
      if (!found) throw requestError('not_found', `${kind} "${name}" not found`, { operation: 'resource', context }, 404);
      return found;
    }
    const query = resourceQuery(context, kind, resourceType(kind).namespaced ? namespace : undefined);
    const meta = options?.metadataOnly ? { metadataOnly: true } : {};
    const httpArgs = { ...query, name, ...(options?.metadataOnly ? { metadataOnly: 'true' } : {}) };
    const nativeArgs = { ...query, name, ...meta };
    const raw = await this.request<any>('get_resource', 'resource', httpArgs, undefined, nativeArgs, signal, options?.priority ?? 'high');
    if (!raw || typeof raw.metadata?.name !== 'string' || !raw.metadata.name || (raw.kind && raw.kind !== kind && !options?.metadataOnly)) {
      throw requestError('internal', 'Invalid resource returned by Kubernetes bridge', { operation: 'resource', context, resource: { ...query, name, uid: null } });
    }
    return mapK8sResource(raw, kind);
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
    const requestedScope = namespace ?? 'all';
    const store = useResourceStore.getState();
    const cachedCounts: Partial<Record<ResourceKind, number>> = {};
    const uncachedKinds: ResourceKind[] = [];

    for (const kind of builtinKinds) {
      const resourceMap = store.resources[kind];
      const watchState = store.watchStates[kind];
      const isNamespaced = resourceType(kind).namespaced;
      const loadedScope = watchState?.query.namespace ?? 'all';
      const covers = !isNamespaced || namespaceScopeCovers(loadedScope, requestedScope);
      const isCurrentContext = !watchState || watchState.query.context === context;

      if (resourceMap && watchState?.hasSnapshot && isCurrentContext && covers) {
        let count = 0;
        for (const item of resourceMap.values()) {
          if (inNamespaceScope(requestedScope, item.namespace)) {
            count++;
          }
        }
        cachedCounts[kind] = count;
      } else {
        uncachedKinds.push(kind);
      }
    }

    if (!uncachedKinds.length) {
      return cachedCounts;
    }

    const names = namespaceNames(namespace ?? 'all');
    if (names && names.length !== 1 && !this.isTauriEnv()) {
      const namespaced = uncachedKinds.filter(kind => resourceType(kind).namespaced);
      const clusterKinds = uncachedKinds.filter(kind => !resourceType(kind).namespaced);
      const [clusterResult, ...sliceResults] = await Promise.allSettled([
        this.getResourceCounts(context, clusterKinds, undefined, signal),
        ...names.map(name => this.getResourceCounts(context, namespaced, name, signal)),
      ]);
      const cluster = clusterResult.status === 'fulfilled' ? clusterResult.value : {};
      const slices = sliceResults.filter((r): r is PromiseFulfilledResult<Partial<Record<ResourceKind, number>>> => r.status === 'fulfilled').map(r => r.value);
      const totals: Partial<Record<ResourceKind, number>> = { ...cachedCounts, ...cluster };
      if (slices.length === names.length) {
        for (const kind of namespaced) {
          const counts = slices.map(slice => slice[kind]);
          if (counts.every((count): count is number => typeof count === 'number')) totals[kind] = counts.reduce((sum, count) => sum + count, 0);
        }
      }
      return totals;
    }
    const queries: ResourceQuery[] = [];
    for (const kind of uncachedKinds) {
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
        { context, ...(singleNamespace ? { namespace: singleNamespace } : {}), kinds: uncachedKinds.join(',') },
        undefined,
        { context, queries },
        signal,
      );
      const counts: Partial<Record<ResourceKind, number>> = { ...cachedCounts };
      for (const [kind, count] of Object.entries(raw ?? {})) {
        if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
          counts[kind as ResourceKind] = count;
        }
      }
      return counts;
    } catch {
      return cachedCounts;
    }
  }

  async getLogs(context: string, name: string, namespace: string, container?: string): Promise<string> {
    if (this.demo) return '';
    return this.request('get_pod_logs', 'logs', { ...resourceQuery(context, 'Pod', namespace), name, container });
  }

  async getCustomResources(context: string, name: string, uid: string, namespace: string | null, signal?: AbortSignal, options?: ReadResourceOptions): Promise<CustomResourceInstance[]> {
    const names = namespaceNames(namespace ?? 'all');
    if (names && names.length !== 1) {
      return this.readNamespacesSettled(
        names,
        ns => this.getCustomResources(context, name, uid, ns, signal, options),
        signal,
        options?.onPartialError,
      );
    }
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
    const extra = this.buildListOptions(options);
    const httpArgs = extra.http ? { context, name, uid, namespace, ...extra.http } : { context, name, uid, namespace };
    const nativeArgs = extra.native ? { context, name, uid, namespace, ...extra.native } : undefined;
    return parseCustomResources(await this.request('get_custom_resources', 'custom-resources', httpArgs, undefined, nativeArgs, signal, options?.priority ?? 'normal', options?.lane ?? 'default'));
  }

  async getCustomResource(context: string, crdName: string, uid: string, namespace: string | null, name: string, options?: { metadataOnly?: boolean; priority?: ReadPriority }, signal?: AbortSignal): Promise<CustomResourceInstance> {
    if (this.demo) {
      const items = await this.getCustomResources(context, crdName, uid, namespace, signal);
      const found = items.find(item => item.name === name && (!item.namespace || item.namespace === namespace));
      if (!found) throw requestError('not_found', `Custom resource "${name}" not found`, { operation: 'custom-resource', context }, 404);
      return found;
    }
    const httpArgs = { context, crdName, uid, namespace, name, ...(options?.metadataOnly ? { metadataOnly: 'true' } : {}) };
    const nativeArgs = { context, crdName, uid, namespace, name, ...(options?.metadataOnly ? { metadataOnly: true } : {}) };
    const raw = await this.request<any>('get_custom_resource', 'custom-resource', httpArgs, undefined, nativeArgs, signal, options?.priority ?? 'high');
    const parsed = parseCustomResources({ items: [raw] });
    if (!parsed.length) throw requestError('internal', 'Invalid custom resource returned by Kubernetes bridge', { operation: 'custom-resource', context });
    return parsed[0];
  }

  async getCustomSearchInventory(context: string, namespace: string | null, signal?: AbortSignal): Promise<{ items: CustomResourceInstance[]; errors: string[] }> {
    const names = namespaceNames(namespace ?? 'all');
    if (names && names.length === 0) return { items: [], errors: [] };
    if (names && names.length > 1) {
      const settled = await Promise.allSettled(names.map(ns => this.getCustomSearchInventory(context, ns, signal)));
      const byUid = new Map<string, CustomResourceInstance>();
      const errors: string[] = [];
      settled.forEach((result, idx) => {
        if (result.status === 'fulfilled') {
          for (const item of result.value.items) byUid.set(`${item.kind}/${item.uid}`, item);
          errors.push(...result.value.errors);
        } else {
          errors.push(`${names[idx]}: ${normalizeK8sError(result.reason, { operation: 'custom-search', context }).message}`);
        }
      });
      return { items: [...byUid.values()], errors: [...new Set(errors)] };
    }
    const scopedNs = names ? names[0] : (namespace && namespace !== 'all' ? namespace : null);
    const raw = await this.request<{ items?: unknown[]; errors?: string[] }>(
      'get_custom_search_inventory',
      'custom-search',
      { context, namespace: scopedNs },
      undefined,
      { context, namespace: scopedNs },
      signal,
      'low',
      'search',
    );
    return {
      items: parseCustomResources({ items: Array.isArray(raw?.items) ? raw.items : [] }),
      errors: Array.isArray(raw?.errors) ? raw.errors : [],
    };
  }

  async getPodMetric(context: string, namespace: string, name: string, signal?: AbortSignal): Promise<import('./overview_metrics').PodMetric> {
    if (this.demo) {
      this.mock ??= buildMockResources();
      const metrics = buildMockMetrics(this.mock, context, namespace);
      const found = metrics.pods.items?.find(item => item.name === name && item.namespace === namespace);
      if (!found) throw requestError('not_found', `Metrics for Pod "${name}" not found`, { operation: 'pod-metric', context }, 404);
      return found;
    }
    return this.request('get_pod_metric', 'pod-metric', { context, namespace, name }, undefined, { context, namespace, name }, signal, 'normal');
  }

  async getOverviewMetrics(context: string, namespace: string | null, signal?: AbortSignal): Promise<import('./overview_metrics').OverviewMetrics> {
    const { validateMetrics } = await import('./overview_metrics');
    const names = namespaceNames(namespace ?? 'all');
    if (names && names.length !== 1) {
      const settled = await Promise.allSettled(names.map(ns => this.getOverviewMetrics(context, ns, signal)));
      const fulfilled = settled
        .filter((r): r is PromiseFulfilledResult<import('./overview_metrics').OverviewMetrics> => r.status === 'fulfilled')
        .map(r => r.value);
      const firstRejected = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      const error = fulfilled.find(result => result.pods.error)?.pods.error
        ?? (firstRejected ? normalizeK8sError(firstRejected.reason, { operation: 'metrics', context }) : null);
      const items = fulfilled.some(result => result.pods.items !== null)
        ? fulfilled.flatMap(result => result.pods.items ?? [])
        : null;
      return { context, namespace, pods: { items, error }, nodes: { items: null, error: null } };
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
