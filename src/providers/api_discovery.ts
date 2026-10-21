import { RESOURCE_TYPES, type ResourceType } from '../core/resources/resource_types';

/** Parse kubectl's discovery table by the stable namespaced column, not optional shortnames. */
export function parseApiResources(table: unknown): ResourceType[] {
  if (typeof table !== 'string') throw new Error('Invalid Kubernetes API discovery response');
  const found = new Map<string, ResourceType>();
  for (const line of table.split('\n')) {
    const columns = line.trim().split(/\s+/);
    const scopeIndex = columns.findIndex(column => column === 'true' || column === 'false');
    if (scopeIndex < 2) continue;
    const apiVersion = columns[scopeIndex - 1];
    const slash = apiVersion.lastIndexOf('/');
    const group = slash < 0 ? '' : apiVersion.slice(0, slash);
    const version = apiVersion.slice(slash + 1);
    const type = RESOURCE_TYPES.find(type => type.kind === columns[scopeIndex + 1] && type.group === group && type.plural === columns[0] && type.namespaced === (columns[scopeIndex] === 'true'));
    if (type && /^v[1-9]\d*(?:(?:alpha|beta)\d+)?$/.test(version)) found.set(type.kind, { ...type, version, watch: /\bwatch\b/.test(columns.slice(scopeIndex + 2).join(' ')) });
  }
  if (!found.size) throw new Error('Kubernetes API discovery did not return any supported collections');
  return [...found.values()];
}
