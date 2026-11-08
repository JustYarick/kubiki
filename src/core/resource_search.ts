import type { ResourceItem } from '../types/k8s';
import { resourceKey } from './resources/identity';

export interface SearchDocument { id: string; fields: Record<string, string[]> }
export interface SearchOptions { query: string; regex: boolean; caseSensitive: boolean }
export interface SearchResult { hits: string[]; total: number; error?: string }
const aliases: Record<string, string> = { namespace: 'ns', type: 'kind', labels: 'label', annotations: 'annotation', apiVersion: 'api' };
const fields = new Set(['name', 'kind', 'ns', 'status', 'label', 'annotation', 'image', 'node', 'api', 'uid']);
export const searchId = (item: ResourceItem) => `${resourceKey(item)}/${item.uid}`;

/** Metadata and selected diagnostic fields only; never Secret data, env values, or full YAML. */
export function searchDocument(item: ResourceItem): SearchDocument {
  const raw = item.raw ?? {};
  const meta = raw.metadata ?? item.metadata ?? {};
  const pairs = (values: Record<string, unknown> = {}) => Object.entries(values).map(([key, value]) => `${key}=${String(value)}`);
  const annotations = Object.entries(meta.annotations ?? {}).map(([key, value]) => key === 'kubectl.kubernetes.io/last-applied-configuration' ? key : `${key}=${String(value)}`);
  const pod = item.kind === 'Pod' ? raw.spec : raw.spec?.template?.spec ?? raw.spec?.jobTemplate?.spec?.template?.spec;
  return { id: searchId(item), fields: {
    name: [item.name], kind: [item.kind], ns: [item.namespace ?? 'cluster'], api: [item.apiVersion], uid: [item.uid],
    status: [item.status ?? '', raw.status?.phase ?? '', ...(raw.status?.conditions ?? []).map((condition: any) => `${condition.type}=${condition.status} ${condition.reason ?? ''}`)],
    label: pairs(meta.labels ?? item.labels), annotation: annotations,
    image: [...(pod?.containers ?? []), ...(pod?.initContainers ?? [])].map((container: any) => String(container.image ?? '')),
    node: [String(raw.spec?.nodeName ?? item.node ?? '')],
  } };
}
function tokenize(query: string): string[] {
  const result: string[] = []; let token = ''; let quote = '';
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (ch === '\\' && quote && query[i + 1] === quote) { token += query[++i]; continue; }
    if (quote) { if (ch === quote) quote = ''; else token += ch; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) { if (token) result.push(token); token = ''; }
    else token += ch;
  }
  if (quote) throw new Error('Close the quoted search term.');
  if (token) result.push(token);
  return result;
}
/** Called inside a disposable worker, including RegExp compilation/evaluation. */
export function searchResources(documents: SearchDocument[], options: SearchOptions, limit = 1000): SearchResult {
  try {
    const normalize = (value: string) => options.caseSensitive ? value : value.toLowerCase();
    const hasFields = /(?:^|\s)-?(?:name|kind|type|ns|namespace|status|label|labels|annotation|annotations|image|node|api|uid):/.test(options.query);
    const terms = options.regex && !hasFields ? [options.query] : tokenize(options.query);
    const compiled = terms.filter(Boolean).map(term => {
      const negative = !(options.regex && !hasFields) && term.startsWith('-') && term.length > 1;
      if (negative) term = term.slice(1);
      const colon = term.indexOf(':');
      const prefix = colon < 0 ? '' : term.slice(0, colon);
      const field = aliases[prefix] ?? prefix;
      const filtered = fields.has(field);
      const value = filtered ? term.slice(colon + 1) : term;
      const pattern = options.regex ? new RegExp(value, options.caseSensitive ? 'm' : 'im') : null;
      return { negative, field: filtered ? field : undefined, value: normalize(value), pattern };
    });
    const scored: { id: string; score: number }[] = [];
    for (const document of documents) {
      let score = 0; let matches = true;
      for (const term of compiled) {
        const values = term.field ? document.fields[term.field] ?? [] : Object.values(document.fields).flat();
        let best = -1;
        for (const source of values) {
          if (term.pattern) { if (term.pattern.test(source)) best = Math.max(best, 100); continue; }
          const text = normalize(source); const at = text.indexOf(term.value);
          if (at >= 0) best = Math.max(best, (text === term.value ? 2000 : 1000) - Math.min(at, 500));
          else if (!term.field) { let cursor = 0; for (const ch of term.value) { const index = text.indexOf(ch, cursor); if (index < 0) { cursor = -1; break; } cursor = index + 1; } if (cursor >= 0) best = Math.max(best, 1); }
        }
        if (term.negative ? best >= 0 : best < 0) { matches = false; break; }
        if (!term.negative) score += best;
      }
      if (matches) scored.push({ id: document.id, score });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return { hits: scored.slice(0, limit).map(item => item.id), total: scored.length };
  } catch (error) { return { hits: [], total: 0, error: error instanceof Error ? error.message : 'Invalid search expression' }; }
}
