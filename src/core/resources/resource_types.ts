import { inNamespaceScope } from './namespace_scope.ts';
import types from '../../../shared/resource-types.json' with { type: 'json' };
import type { ResourceKind } from '../../types/k8s.ts';

export interface GroupVersionKind { group: string; version: string; kind: string }
export interface ResourceType extends GroupVersionKind { plural: string; namespaced: boolean; watch?: boolean }
export interface ResourceQuery extends GroupVersionKind { context: string; namespace: string | null }
export interface ResourceRef extends ResourceQuery { name: string; uid: string | null }

export const RESOURCE_TYPES: readonly ResourceType[] = types;
const discoveredVersions = new Map<string, Pick<ResourceType, 'version' | 'watch'>>();
export function setDiscoveredResourceTypes(resources: readonly ResourceType[] = []) {
  discoveredVersions.clear();
  for (const type of resources) discoveredVersions.set(type.kind, { version: type.version, watch: type.watch });
}

/**
 * Kinds loaded cluster-wide regardless of the namespace selection.
 *
 * Global objects report metrics derived from these objects — a Node counts the
 * Pods running on it — so narrowing the namespace must not change their numbers.
 * When the API denies cluster-wide access the load falls back to the selected
 * namespaces.
 */
export const SCOPE_INDEPENDENT_KINDS: ReadonlySet<ResourceKind> = new Set<ResourceKind>(['Pod']);

/** Scope to request for a kind — scope-independent kinds are always read cluster-wide. */
export function scopeForKind(kind: ResourceKind, scope: string): string {
  return SCOPE_INDEPENDENT_KINDS.has(kind) ? 'all' : scope;
}

export function resourceType(kind: ResourceKind): ResourceType {
  if (kind === 'HelmRelease') return { group: 'helm.sh', version: 'v1', kind, plural: 'releases', namespaced: true };
  const type = RESOURCE_TYPES.find((type) => type.kind === kind);
  if (!type) throw new Error(`Unsupported resource kind: ${kind}`);
  const discovered = discoveredVersions.get(kind);
  return discovered ? { ...type, ...discovered } : type;
}

export function parseApiVersion(apiVersion: string): Pick<GroupVersionKind, 'group' | 'version'> {
  const parts = apiVersion.split('/');
  return parts.length === 1 ? { group: '', version: parts[0] } : { group: parts[0], version: parts[1] };
}

export function apiVersionFor(type: GroupVersionKind): string {
  return type.group ? `${type.group}/${type.version}` : type.version;
}

export function resourceQuery(context: string, kind: ResourceKind, namespace?: string): ResourceQuery {
  const { group, version, namespaced } = resourceType(kind);
  return { context, group, version, kind, namespace: namespaced && namespace && namespace !== 'all' ? namespace : null };
}

/** Kubernetes namespace names follow DNS label syntax (the same validation as core). */
export function isValidNamespaceName(value: string): boolean {
  return value.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);
}

export function namespaceIsOutsideScope(namespace: string | undefined, selectedNamespace: string, syncMode: string): boolean {
  return syncMode === 'watch' && selectedNamespace !== 'all' && namespace !== undefined && !inNamespaceScope(selectedNamespace, namespace);
}

export function namespaceFallback(kind: ResourceKind, requestedScope: string | null, selectedScope: string, code?: string): string | undefined {
  return SCOPE_INDEPENDENT_KINDS.has(kind) && (requestedScope === null || requestedScope === 'all') && code === 'forbidden' ? selectedScope : undefined;
}
