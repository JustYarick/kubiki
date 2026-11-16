import { searchResources, type SearchDocument, type SearchOptions } from '../core/resource_search';

let indexed: SearchDocument[] = [];

type WorkerRequest =
  | { type: 'index'; documents: SearchDocument[] }
  | { type?: 'search'; id?: number; documents?: SearchDocument[]; options: SearchOptions };

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const payload = event.data;
  if (payload.type === 'index') {
    indexed = payload.documents;
    return;
  }
  const result = searchResources(payload.documents ?? indexed, payload.options);
  self.postMessage(payload.id !== undefined ? { id: payload.id, result } : result);
};
