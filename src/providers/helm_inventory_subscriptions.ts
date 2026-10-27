import { namespaceNames } from '../core/resources/namespace_scope';
import { k8s } from './k8s_provider';
import { loadHelmInventory } from './helm_inventory';
import { ReadSubscriptions, type ReadSnapshot } from './read_subscriptions';
import type { HelmRelease } from './helm_types';

const subscriptions = new ReadSubscriptions<HelmRelease[]>(async (key, signal) => {
  const [context, namespace] = JSON.parse(key) as [string, string | null];
  return loadHelmInventory((...args) => k8s.getHelmInventory(...args), context, namespace, signal);
}, 30000);
const active = new Map<string, number>();
const changes = new Set<() => void>();

export function helmInventoryKey(context: string, namespace: string | null): string {
  const names = namespaceNames(namespace ?? 'all');
  const scope = names ? names.length === 1 ? names[0] : JSON.stringify([...names].sort()) : null;
  return JSON.stringify([context, scope]);
}

/** Tables and diagrams share the same native snapshot and release its last reader. */
export function subscribeHelmInventory(context: string, namespace: string | null, receive: (snapshot: ReadSnapshot<HelmRelease[]>) => void): () => void {
  const key = helmInventoryKey(context, namespace);
  active.set(key, (active.get(key) ?? 0) + 1);
  const stop = subscriptions.subscribe(key, receive);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    stop();
    const remaining = (active.get(key) ?? 1) - 1;
    if (remaining) active.set(key, remaining);else active.delete(key);
  };
}

export function refreshHelmInventory(context: string, namespace: string | null) {
  subscriptions.refresh(helmInventoryKey(context, namespace));
}

export function subscribeHelmChanges(listener: () => void) {
  changes.add(listener);
  return () => { changes.delete(listener); };
}

export function invalidateHelmGraphs() {
  subscriptions.clearCache();
  for (const key of active.keys()) subscriptions.refresh(key, true);
  for (const listener of changes) listener();
}
