import { useEffect, useMemo, useState } from 'react';
import type { ResourceItem } from '../types/k8s';
import { searchDocument, searchId, type SearchOptions, type SearchResult } from '../core/resource_search';

export function useResourceSearch(items: ResourceItem[], options: SearchOptions, enabled: boolean) {
  const documents = useMemo(() => items.map(searchDocument), [items]);
  const byId = useMemo(() => new Map(items.map(item => [searchId(item), item])), [items]);
  const signature = JSON.stringify(options);
  const [state, setState] = useState<SearchResult & { signature: string; pending: boolean }>({ signature: '', pending: false, hits: [], total: 0 });
  useEffect(() => {
    if (!enabled) return;
    let active = true; let worker: Worker | undefined; let deadline: ReturnType<typeof setTimeout> | undefined;
    setState(previous => ({ ...previous, pending: true }));
    const start = setTimeout(() => {
      const complete = (result: SearchResult) => {
        clearTimeout(deadline); worker?.terminate();
        if (active) setState({ ...result, signature, pending: false });
      };
      try {
        worker = new Worker(new URL('./resource_search_worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<SearchResult>) => complete(event.data);
        worker.onerror = event => { event.preventDefault(); complete({ hits: [], total: 0, error: 'Search worker could not run. Refresh the inventory to retry.' }); };
        deadline = setTimeout(() => complete({ hits: [], total: 0, error: 'Search took too long. Simplify the expression or narrow the filters.' }), 2000);
        worker.postMessage({ documents, options: JSON.parse(signature) });
      } catch { complete({ hits: [], total: 0, error: 'Search worker unavailable.' }); }
    }, 120);
    return () => { active = false; clearTimeout(start); clearTimeout(deadline); worker?.terminate(); };
  }, [documents, signature, enabled]);
  const current = state.signature === signature;
  return { items: current && enabled ? state.hits.flatMap(id => byId.has(id) ? [byId.get(id)!] : []) : [], total: current ? state.total : 0, error: current ? state.error : undefined, pending: enabled && (!current || state.pending) };
}
