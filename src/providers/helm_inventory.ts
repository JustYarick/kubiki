import { namespaceNames } from '../core/resources/namespace_scope';
import type { HelmRelease } from './helm_types';
import { requestError } from './errors';

type Reader = (context: string, namespace: string | null, signal?: AbortSignal) => Promise<HelmRelease[]>;
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
