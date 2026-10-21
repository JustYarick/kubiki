import type { ResourceItem } from '../../types/k8s';
import { parseApiVersion, RESOURCE_TYPES } from './resource_types';

export interface CustomColumn { name: string; type: string; jsonPath: string; priority: number }
export interface CustomResourceType {
  name: string; uid: string; group: string; version: string; kind: string; plural: string; singular?: string; shortNames?: string[]; namespaced: boolean; key: string; columns: CustomColumn[];
}
const GATEWAY_LABELS: Record<string, string> = { Gateway: 'Gateways', GatewayClass: 'Gateway Classes', HTTPRoute: 'HTTP Routes', GRPCRoute: 'gRPC Routes', TCPRoute: 'TCP Routes', UDPRoute: 'UDP Routes', TLSRoute: 'TLS Routes', ListenerSet: 'Listener Sets', ReferenceGrant: 'Reference Grants', BackendTLSPolicy: 'Backend TLS Policies' };
export function customResourcePlacement(type: Pick<CustomResourceType, 'group' | 'kind'>): { category: 'config' | 'gateway'; label: string } | undefined {
  if (type.group === 'autoscaling.k8s.io' && type.kind === 'VerticalPodAutoscaler') return { category: 'config', label: 'Vertical Pod Autoscalers' };
  if (type.group === 'gateway.networking.k8s.io' && GATEWAY_LABELS[type.kind]) return { category: 'gateway', label: GATEWAY_LABELS[type.kind] };
}
export function customResourceType(item: ResourceItem): CustomResourceType | undefined {
  const spec = item.raw?.spec ?? item.spec;
  if (!spec || typeof spec.group !== 'string' || !spec.group || typeof spec.names?.kind !== 'string' || !spec.names.kind) return;
  const plural = spec.names.plural || (spec.names.kind.toLowerCase() + 's');
  const scopeNormalized = String(spec.scope ?? '').toLowerCase();
  const isNamespaced = scopeNormalized === 'namespaced' || scopeNormalized === '';
  const isCluster = scopeNormalized === 'cluster';
  if (!isNamespaced && !isCluster) return;

  const rawVersions = Array.isArray(spec.versions) && spec.versions.length > 0
    ? spec.versions
    : spec.version ? [{ name: String(spec.version), served: true, storage: true }] : [];
  const servedVersions = rawVersions.filter((v: any) => v.served !== false);
  const version = servedVersions.find((v: any) => v.storage) ?? servedVersions[0] ?? rawVersions[0];
  if (!version?.name) return;

  const name = item.raw?.metadata?.name || item.name || `${plural}.${spec.group}`;
  const shortNames = Array.isArray(spec.names.shortNames) ? spec.names.shortNames : [];
  const singular = typeof spec.names.singular === 'string' ? spec.names.singular : undefined;

  return {
    name,
    uid: item.uid || name,
    group: spec.group,
    version: String(version.name),
    kind: spec.names.kind,
    plural,
    singular,
    shortNames,
    namespaced: isNamespaced,
    key: `custom:${spec.group}/${spec.names.kind}`,
    columns: (version.additionalPrinterColumns ?? spec.additionalPrinterColumns ?? [])
      .filter((column: any) => typeof column.name === 'string' && typeof column.jsonPath === 'string')
      .map((column: any) => ({
        name: column.name,
        type: column.type ?? 'string',
        jsonPath: column.jsonPath,
        priority: column.priority ?? 0,
      })),
  };
}
/** Isolate matching Kind names in different API groups, including names shared with built-ins. */
export function resourceBucket(item: { kind: string; apiVersion?: string }): string {
  if (!item.apiVersion || item.kind === 'HelmRelease' && item.apiVersion === 'helm.sh/v1') return item.kind;
  const { group } = parseApiVersion(item.apiVersion);
  return RESOURCE_TYPES.some(type => type.kind === item.kind && type.group === group) ? item.kind : `custom:${group}/${item.kind}`;
}
/** Safe subset used by CRD printer columns: fields, indexes, wildcards and equality filters. */
export function customColumnValue(raw: unknown, path: string): string | undefined {
  if (raw == null || !path) return;
  const source = path.replace(/^\$?\.?/, '.');
  const token = /\.([\w-]+)|\[(\d+)\]|\[\*\]|\[\?\(@\.([\w.]+)\s*==\s*(['"])(.*?)\4\)\]|\[['"]([^'"]+)['"]\]/gy;
  let values: any[] = [raw];
  let position = 0;
  while (position < source.length) {
    token.lastIndex = position;
    const match = token.exec(source);
    if (!match) return;
    position = token.lastIndex;
    if (match[3]) values = values.flatMap(value => Array.isArray(value) ? value.filter(entry => match[3].split('.').reduce((entry, key) => entry?.[key], entry) === match[5]) : []);
    else if (match[0] === '[*]') values = values.flatMap(value => Array.isArray(value) ? value : []);
    else values = values.flatMap(value => Array.isArray(value) && !match[2] ? value.map(entry => entry?.[match[1] ?? match[6]]) : [value?.[match[2] ?? match[1] ?? match[6]]]);
  }
  const result = values.filter(value => value != null).map(value => typeof value === 'object' ? JSON.stringify(value) : String(value));
  return result.length ? result.join(', ') : undefined;
}
