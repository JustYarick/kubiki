import { namespaceNames } from '../core/resources/namespace_scope';
import type { HelmRelease } from './helm_types';
import { normalizeK8sError, requestError, type K8sRequestError } from './errors';

type Reader = (context: string, namespace: string | null, signal?: AbortSignal) => Promise<HelmRelease[]>;

export interface PartialScopeError {
  scope: string;
  error: K8sRequestError;
}

export interface HelmInventoryResult {
  items: HelmRelease[];
  partialErrors: PartialScopeError[];
}

async function readNamespacesPartial(
  read: Reader,
  context: string,
  namespaces: Array<string | null>,
  signal: AbortSignal,
): Promise<{ items: HelmRelease[]; partialErrors: PartialScopeError[]; succeeded: number }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  signal.addEventListener('abort', abort, { once: true });
  const items: HelmRelease[] = [];
  const partialErrors: PartialScopeError[] = [];
  const identities = new Set<string>();
  let succeeded = 0;
  let next = 0;
  const worker = async () => {
    while (!controller.signal.aborted && next < namespaces.length) {
      const namespace = namespaces[next++];
      try {
        const snapshot = await read(context, namespace, controller.signal);
        succeeded += 1;
        for (const release of snapshot) {
          const key = JSON.stringify([release.namespace, release.name]);
          if (identities.has(key)) throw requestError('conflict', 'The release list contains duplicate identities. Refresh to collect a complete summary.', { operation: 'helm', context });
          identities.add(key);
          items.push(release);
        }
      } catch (error) {
        if (controller.signal.aborted || signal.aborted) throw error;
        const normalized = normalizeK8sError(error, { operation: 'helm', context });
        if (normalized.code === 'conflict' || normalized.code === 'cancelled') throw error;
        partialErrors.push({ scope: namespace ?? 'all namespaces', error: normalized });
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(3, namespaces.length) }, worker));
    if (signal.aborted) throw requestError('cancelled', 'Release read cancelled', { operation: 'helm', context });
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
  return {
    items: items.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name)),
    partialErrors: partialErrors.sort((a, b) => a.scope.localeCompare(b.scope)),
    succeeded,
  };
}

/** Read Helm releases across namespaces, retaining accessible namespaces when another returns 403/error. */
export async function loadPartialHelmInventory(
  read: Reader,
  context: string,
  scope: string | null,
  signal: AbortSignal,
  fallbackNamespaces: string[] = [],
): Promise<HelmInventoryResult> {
  const namespaces = namespaceNames(scope ?? 'all');
  if (namespaces && namespaces.length === 0) return { items: [], partialErrors: [] };
  if (namespaces && namespaces.length > 0) {
    const result = await readNamespacesPartial(read, context, namespaces, signal);
    if (result.succeeded === 0 && result.partialErrors.length > 0) {
      throw result.partialErrors[0].error;
    }
    return { items: result.items, partialErrors: result.partialErrors };
  }
  try {
    const items = await read(context, null, signal);
    if (signal.aborted) throw requestError('cancelled', 'Release read cancelled', { operation: 'helm', context });
    return {
      items: [...items].sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name)),
      partialErrors: [],
    };
  } catch (error) {
    if (signal.aborted) throw error;
    const normalized = normalizeK8sError(error, { operation: 'helm', context });
    if (normalized.code === 'forbidden' && fallbackNamespaces.length > 0) {
      const unique = [...new Set(fallbackNamespaces.filter(Boolean))];
      if (unique.length > 0) {
        const result = await readNamespacesPartial(read, context, unique, signal);
        if (result.succeeded > 0) {
          return { items: result.items, partialErrors: result.partialErrors };
        }
      }
    }
    throw error;
  }
}

/** Read one complete snapshot per selected namespace, never CLI offset pages. */
export async function loadHelmInventory(read: Reader, context: string, scope: string | null, signal: AbortSignal): Promise<HelmRelease[]> {
  const namespaces: Array<string | null> = namespaceNames(scope ?? 'all') ?? [null];
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  signal.addEventListener('abort', abort, { once: true });
  const items: HelmRelease[] = [];
  const identities = new Set<string>();
  let next = 0;
  const worker = async () => {
    while (!controller.signal.aborted && next < namespaces.length) {
      const namespace = namespaces[next++];
      const snapshot = await read(context, namespace, controller.signal);
      for (const release of snapshot) {
        const key = JSON.stringify([release.namespace, release.name]);
        if (identities.has(key)) throw requestError('conflict', 'The release list contains duplicate identities. Refresh to collect a complete summary.', { operation: 'helm', context });
        identities.add(key);items.push(release);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(3, namespaces.length) }, worker));
    if (signal.aborted) throw requestError('cancelled', 'Release read cancelled', { operation: 'helm', context });
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
  return items.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}
