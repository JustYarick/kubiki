import { namespaceNames } from '../core/resources/namespace_scope';
import type { HelmRelease, HelmReleasePage } from './helm_types';
import { requestError } from './errors';

type Reader = (context: string, namespace: string | null, offset: number, signal?: AbortSignal) => Promise<HelmReleasePage>;
/** Collect every page of each selected namespace before publishing exact totals. */
export async function loadHelmInventory(read: Reader, context: string, scope: string | null, signal: AbortSignal): Promise<HelmRelease[]> {
  const namespaces: Array<string | null> = namespaceNames(scope ?? 'all') ?? [null];
  const items: HelmRelease[] = [];
  const identities = new Set<string>();
  let next = 0;
  const worker = async () => {
    while (!signal.aborted && next < namespaces.length) {
      const namespace = namespaces[next++];
      let offset = 0;
      for (let pageIndex = 0; ; pageIndex++) {
        if (signal.aborted) throw requestError('cancelled', 'Release read cancelled', { operation: 'helm', context });
        if (pageIndex >= 1000) throw requestError('unsupported', 'Too many releases to collect a complete summary. Select fewer namespaces.', { operation: 'helm', context });
        const page = await read(context, namespace, offset, signal);
        for (const release of page.items) {
          const key = JSON.stringify([release.namespace, release.name]);
          if (identities.has(key)) throw requestError('conflict', 'The release list changed while loading. Refresh to collect a complete summary.', { operation: 'helm', context });
          identities.add(key);items.push(release);
        }
        if (!page.has_more) break;
        if (!page.items.length || page.limit <= 0) throw requestError('internal', 'Helm returned a non-advancing release page', { operation: 'helm', context });
        offset += page.limit;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, namespaces.length) }, worker));
  if (signal.aborted) throw requestError('cancelled', 'Release read cancelled', { operation: 'helm', context });
  return items.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}
