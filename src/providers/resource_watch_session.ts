import { inNamespaceScope } from '../core/resources/namespace_scope';
import type { ResourceItem, ResourceKind } from '../types/k8s';
import { apiVersionFor, resourceQuery, resourceType, SCOPE_INDEPENDENT_KINDS, namespaceFallback, type ResourceQuery } from '../core/resources/resource_types';
import { mapK8sResource } from '../core/utils/k8s_mapper';
import { normalizeK8sError, requestError, type K8sRequestError } from './errors';
import { sameQuery, type ResourceWatchProvider, type WatchBatch, type WatchCommit, type WatchDelta, type WatchPhase } from './watch_types';
import { InitialSyncQueue } from './initial_sync_queue';

export const WATCH_FLUSH_MS = 50;
export const FIRST_SYNC_TIMEOUT_MS = 30000;
const MAX_PENDING_CHANGES = 5000;
const PHASES: WatchPhase[] = ['connecting', 'syncing', 'live', 'reconnecting', 'failed', 'stopped'];
interface Subscription {
  query: ResourceQuery; abort: AbortController; close?: () => void; sequence: number;
  changes: Map<string, WatchDelta>; snapshot?: Record<string, any>[];
  phase: WatchPhase; error?: K8sRequestError; hasSnapshot: boolean;
  flushTimer?: ReturnType<typeof setTimeout>; firstTimer?: ReturnType<typeof setTimeout>;
  settle: (error?: K8sRequestError) => void;
}

/** One UI generation owns its subscriptions. A late callback/ack cannot write into the next generation. */
export class ResourceWatchSession {
  private active = true;
  private subscriptions = new Map<ResourceKind, Subscription>();
  /** Kinds that fell back to namespace-scoped reads because cluster-wide access was denied. */
  private scopedFallback = new Set<ResourceKind>();
  private initialSync = new InitialSyncQueue();
  constructor(readonly context: string, private provider: ResourceWatchProvider, private commit: (kind: ResourceKind, update: WatchCommit) => void, private namespace = 'all', private clusterKinds: ReadonlySet<ResourceKind> = SCOPE_INDEPENDENT_KINDS, private cachedSnapshot?: (query: ResourceQuery) => ResourceItem[] | undefined) {}

  async start(kinds: ResourceKind[]): Promise<PromiseSettledResult<void>[]> { return Promise.allSettled(kinds.map((kind) => this.refresh(kind))); }

  private scope(kind: ResourceKind): string {
    return this.clusterKinds.has(kind) && !this.scopedFallback.has(kind) ? 'all' : this.namespace;
  }

  /** Stop unused streams and keep exactly one subscription for each demanded kind. */
  async setKinds(kinds: readonly ResourceKind[], clusterKinds: ReadonlySet<ResourceKind> = this.clusterKinds): Promise<PromiseSettledResult<void>[]> {
    if (!this.active) return [];
    this.clusterKinds = clusterKinds;
    const wanted = new Set(kinds);
    for (const [kind, subscription] of this.subscriptions) if (!wanted.has(kind)) {
      this.closeSubscription(subscription);
      this.subscriptions.delete(kind);
      this.commit(kind, { changes: [], state: { query: subscription.query, phase: 'stopped', hasSnapshot: subscription.hasSnapshot } });
    }
    return Promise.allSettled([...wanted].filter(kind => {
      const previous = this.subscriptions.get(kind);
      return !previous || !sameQuery(previous.query, resourceQuery(this.context, kind, this.scope(kind)));
    }).map(kind => this.refresh(kind)));
  }

  /**
   * Subscribe to a kind. Scope-independent kinds read the whole cluster so global
   * objects keep stable metrics; when the API denies that, they fall back to the
   * selected namespaces.
   */
  async refresh(kind: ResourceKind, forcedScope?: string): Promise<void> {
    if (!this.active) return Promise.resolve();
    const previous = this.subscriptions.get(kind);
    if (previous) this.closeSubscription(previous);
    const scope = forcedScope ?? this.scope(kind);
    const query = resourceQuery(this.context, kind, scope);
    const sameScope = previous && sameQuery(previous.query, query);
    const cached = !sameScope ? this.cachedSnapshot?.(query) : undefined;
    let resolve!: () => void; let reject!: (error: K8sRequestError) => void;
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    let settled = false;
    const subscription: Subscription = { query, abort: new AbortController(), sequence: 0, changes: new Map(), phase: 'connecting', hasSnapshot: sameScope ? previous.hasSnapshot : cached !== undefined,
      settle: (error) => { if (settled) return; settled = true; clearTimeout(subscription.firstTimer); if (error) reject(error); else resolve(); } };
    this.subscriptions.set(kind, subscription);
    this.commit(kind, { ...(!sameScope ? { snapshot: cached ?? [] } : {}), changes: [], state: { query, phase: 'connecting', hasSnapshot: subscription.hasSnapshot } });
    void this.initialSync.run(async () => {
      if (!this.current(kind, subscription)) return;
      subscription.firstTimer = setTimeout(() => this.fail(kind, subscription, requestError('timeout', 'Initial resource watch sync timed out', { operation: 'watch', context: this.context, resource: query }, 504)), FIRST_SYNC_TIMEOUT_MS);
      void Promise.resolve().then(() => {
        if (!this.current(kind, subscription)) return;
        return this.provider.watchResources(query, (batch) => this.receive(kind, subscription, batch), subscription.abort.signal);
      }).then((close) => {
        subscription.close = close;
        if (!this.current(kind, subscription)) close?.();
      }).catch((error) => { if (this.current(kind, subscription)) this.fail(kind, subscription, normalizeK8sError(error, { operation: 'watch', context: this.context, resource: query })); });
      await ready.catch(() => {});
    }, subscription.abort.signal);
    try {
      await ready;
    } catch (error) {
      // Cluster-wide access can be denied by RBAC: keep the namespace-scoped read.
      if (this.active && this.subscriptions.get(kind) === subscription && this.clusterKinds.has(kind) && !this.scopedFallback.has(kind) && namespaceFallback(kind, query.namespace, this.namespace, (error as K8sRequestError)?.code)) {
        this.scopedFallback.add(kind);
        if (this.namespace !== 'all') {
          await this.refresh(kind, this.namespace);
          return;
        }
      }
      throw error;
    }
  }

  private current(kind: ResourceKind, subscription: Subscription): boolean { return this.active && !subscription.abort.signal.aborted && this.subscriptions.get(kind) === subscription; }

  private receive(kind: ResourceKind, subscription: Subscription, batch: WatchBatch): void {
    if (!this.current(kind, subscription)) return;
    try {
      if (!sameQuery(batch.query, subscription.query)) return;
      if (!Array.isArray(batch.messages)) throw new Error('Malformed resource watch batch');
      for (const message of batch.messages) {
        if (!Number.isSafeInteger(message.sequence) || message.sequence <= 0) throw new Error('Invalid resource watch sequence');
        if (message.sequence <= subscription.sequence) continue;
        if (message.sequence !== subscription.sequence + 1) throw new Error('Resource watch sequence gap; refresh to resynchronize');
        subscription.sequence = message.sequence;
        const event = message.event;
        if (event.type === 'Status') {
          if (!PHASES.includes(event.payload.phase)) throw new Error('Invalid resource watch state');
          subscription.phase = event.payload.phase;
          subscription.error = event.payload.error ? normalizeK8sError(event.payload.error, { operation: 'watch', context: this.context, resource: subscription.query }) : undefined;
        } else if (event.type === 'Delta') {
          const delta = event.payload;
          if (delta.type === 'Restarted') {
            if (!Array.isArray(delta.payload.items)) throw new Error('Malformed resource watch snapshot');
            // Check the entire snapshot before replacing even one visible object.
            for (const raw of delta.payload.items) this.validateObject(raw, subscription.query);
            subscription.snapshot = delta.payload.items; subscription.changes.clear();
          } else {
            if (!subscription.hasSnapshot && !subscription.snapshot) throw new Error('Resource delta arrived before first sync');
            let uid: string;
            if (delta.type === 'Applied') { this.validateObject(delta.payload.data, subscription.query); uid = delta.payload.data.metadata.uid; }
            else if (delta.type === 'Deleted' && typeof delta.payload.uid === 'string' && delta.payload.uid) uid = delta.payload.uid;
            else throw new Error('Invalid resource watch delta');
            subscription.changes.set(uid, delta);
            if (subscription.changes.size > MAX_PENDING_CHANGES) throw new Error('Resource watch buffer exceeded; refresh to resynchronize');
          }
        } else throw new Error('Unknown resource watch message');
      }
      subscription.flushTimer ??= setTimeout(() => this.flush(kind, subscription), WATCH_FLUSH_MS);
    } catch (error) { this.fail(kind, subscription, normalizeK8sError(error, { operation: 'watch', context: this.context, resource: subscription.query })); }
  }

  private validateObject(raw: Record<string, any>, query: ResourceQuery): void {
    const type = resourceType(query.kind as ResourceKind);
    const namespaced = type.namespaced;
    if (!raw || type.watch !== false && (typeof raw.metadata?.uid !== 'string' || !raw.metadata.uid) || typeof raw.metadata?.name !== 'string' || !raw.metadata.name
      || namespaced && (typeof raw.metadata.namespace !== 'string' || !raw.metadata.namespace)
      || !namespaced && raw.metadata.namespace
      || query.namespace && !inNamespaceScope(query.namespace, raw.metadata.namespace)
      || raw.kind && raw.kind !== query.kind || raw.apiVersion && raw.apiVersion !== apiVersionFor(query)) throw new Error('Watch object does not match the requested resource scope');
  }

  private flush(kind: ResourceKind, subscription: Subscription): void {
    subscription.flushTimer = undefined;
    if (!this.current(kind, subscription)) return;
    try {
      const snapshot = subscription.snapshot?.map((raw) => mapK8sResource(raw, kind));
      if (snapshot) subscription.hasSnapshot = true;
      if (subscription.phase === 'live' && !subscription.hasSnapshot) throw new Error('Resource watch reported live without a complete snapshot');
      const changes: WatchCommit['changes'] = [...subscription.changes.values()].map((delta) => delta.type === 'Applied'
        ? { type: 'apply', item: mapK8sResource(delta.payload.data, kind) } : { type: 'delete', uid: (delta as Extract<WatchDelta, { type: 'Deleted' }>).payload.uid });
      if ((subscription.phase === 'failed' || subscription.phase === 'stopped') && !subscription.error) subscription.error = requestError('unavailable', 'Resource watch stopped', { operation: 'watch', context: this.context, resource: subscription.query });
      this.commit(kind, { snapshot, changes, state: { query: subscription.query, phase: subscription.phase, hasSnapshot: subscription.hasSnapshot, updatedAt: Date.now() }, error: subscription.error });
      subscription.snapshot = undefined; subscription.changes.clear();
      if (subscription.phase === 'failed' || subscription.phase === 'stopped') {
        const error = subscription.error ?? requestError('unavailable', 'Resource watch stopped', { operation: 'watch', context: this.context, resource: subscription.query });
        subscription.settle(error); this.closeSubscription(subscription);
      } else if (subscription.hasSnapshot && subscription.phase === 'live') subscription.settle();
    } catch (error) { this.fail(kind, subscription, normalizeK8sError(error, { operation: 'watch', context: this.context, resource: subscription.query })); }
  }

  private fail(kind: ResourceKind, subscription: Subscription, error: K8sRequestError): void {
    if (!this.current(kind, subscription)) return;
    this.commit(kind, { changes: [], state: { query: subscription.query, phase: 'failed', hasSnapshot: subscription.hasSnapshot }, error });
    subscription.settle(error); this.closeSubscription(subscription);
  }

  private closeSubscription(subscription: Subscription): void {
    subscription.abort.abort(); subscription.close?.(); clearTimeout(subscription.flushTimer); clearTimeout(subscription.firstTimer);
    subscription.changes.clear(); subscription.snapshot = undefined; subscription.settle();
  }

  /** Only namespaced kinds change scope; cluster watches and their snapshots stay intact. */
  async setNamespace(namespace: string): Promise<PromiseSettledResult<void>[]> {
    if (!this.active || namespace === this.namespace) return [];
    this.namespace = namespace;
    // Scope-independent kinds keep their cluster-wide watch — unless RBAC denied it,
    // in which case they follow the selected namespace like every other namespaced kind.
    const scoped = [...this.subscriptions.keys()].filter((kind) => resourceType(kind).namespaced && (this.scopedFallback.has(kind) || !this.clusterKinds.has(kind)));
    return Promise.allSettled(scoped.map((kind) => this.refresh(kind)));
  }

  async refreshAll(): Promise<PromiseSettledResult<void>[]> { return Promise.allSettled([...this.subscriptions.keys()].map((kind) => this.refresh(kind))); }
  stop(): void { this.active = false; for (const subscription of this.subscriptions.values()) this.closeSubscription(subscription); this.subscriptions.clear(); }
}
