import { searchResources, type SearchDocument, type SearchOptions } from '../core/resource_search';
self.onmessage = (event: MessageEvent<{ documents: SearchDocument[]; options: SearchOptions }>) => {
  self.postMessage(searchResources(event.data.documents, event.data.options));
};
