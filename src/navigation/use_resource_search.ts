import { useEffect, useMemo, useRef, useState } from 'react';
import type { ResourceItem } from '../types/k8s';
import { searchDocumentCached, searchId, type SearchDocument, type SearchOptions, type SearchResult } from '../core/resource_search';

export function useResourceSearch(items: ResourceItem[], options: SearchOptions, enabled: boolean) {
  const documents = useMemo(() => items.map(searchDocumentCached), [items]);
  const byId = useMemo(() => new Map(items.map(item => [searchId(item), item])), [items]);
  const signature = JSON.stringify(options);
  const workerRef = useRef<Worker | null>(null);
  const indexedDocsRef = useRef<SearchDocument[] | null>(null);
  const searchSeqRef = useRef(0);
  const [state, setState] = useState<SearchResult & { signature: string; pending: boolean }>({ signature: '', pending: false, hits: [], total: 0 });

  useEffect(() => {
    if (!enabled) {
      workerRef.current?.terminate();
      workerRef.current = null;
      indexedDocsRef.current = null;
    }
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      indexedDocsRef.current = null;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const seq = ++searchSeqRef.current;
    setState(previous => ({ ...previous, pending: true }));

    const start = setTimeout(() => {
      const complete = (result: SearchResult, recreateWorker = false) => {
        clearTimeout(deadline);
        if (recreateWorker) {
          workerRef.current?.terminate();
          workerRef.current = null;
          indexedDocsRef.current = null;
        }
        if (active && seq === searchSeqRef.current) setState({ ...result, signature, pending: false });
      };

      try {
        if (!workerRef.current) {
          workerRef.current = new Worker(new URL('./resource_search_worker.ts', import.meta.url), { type: 'module' });
          indexedDocsRef.current = null;
        }
        const worker = workerRef.current;
        worker.onmessage = (event: MessageEvent<{ id?: number; result?: SearchResult } & SearchResult>) => {
          const payload = event.data;
          if (payload.id !== undefined && payload.id !== searchSeqRef.current) return;
          complete(payload.result ?? payload);
        };
        worker.onerror = (event) => {
          event.preventDefault();
          complete({ hits: [], total: 0, error: 'Search worker could not run. Refresh the inventory to retry.' }, true);
        };
        deadline = setTimeout(() => {
          complete({ hits: [], total: 0, error: 'Search took too long. Simplify the expression or narrow the filters.' }, true);
        }, 2000);
        if (indexedDocsRef.current !== documents) {
          worker.postMessage({ type: 'index', documents });
          indexedDocsRef.current = documents;
        }
        worker.postMessage({ type: 'search', id: seq, options: JSON.parse(signature) });
      } catch {
        complete({ hits: [], total: 0, error: 'Search worker unavailable.' }, true);
      }
    }, 80);

    return () => {
      active = false;
      clearTimeout(start);
      clearTimeout(deadline);
    };
  }, [documents, signature, enabled]);

  const current = state.signature === signature;
  return {
    items: current && enabled ? state.hits.flatMap(id => byId.has(id) ? [byId.get(id)!] : []) : [],
    total: current ? state.total : 0,
    error: current ? state.error : undefined,
    pending: enabled && (!current || state.pending),
  };
}
