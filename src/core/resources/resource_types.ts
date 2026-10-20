import types from '../../../shared/resource-types.json' with { type: 'json' };
import type { ResourceKind } from '../../types/k8s.ts';

export interface GroupVersionKind { group: string; version: string; kind: string }
export interface ResourceType extends GroupVersionKind { plural: string; namespaced: boolean }
export interface ResourceQuery extends GroupVersionKind { context: string; namespace: string | null }
export interface ResourceRef extends ResourceQuery { name: string; uid: string | null }

export const RESOURCE_TYPES: readonly ResourceType[] = types;

export function resourceType(kind: ResourceKind): ResourceType {
  const type = RESOURCE_TYPES.find((type) => type.kind === kind);
  if (!type) throw new Error(`Unsupported resource kind: ${kind}`);
  return type;
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
