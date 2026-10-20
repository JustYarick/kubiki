import type { ResourceItem } from '../../types/k8s';
import { parseApiVersion, type ResourceRef } from './resource_types';

/** Versions of one API group identify the same logical object; recreations have a new UID. */
export function resourceKey(item: { kind: string; apiVersion: string; namespace?: string; name: string }): string {
  return JSON.stringify([parseApiVersion(item.apiVersion).group, item.kind, item.namespace ?? '', item.name]);
}

export function resourceRef(context: string, item: ResourceItem): ResourceRef {
  return { context, ...parseApiVersion(item.apiVersion), kind: item.kind, namespace: item.namespace ?? null, name: item.name, uid: item.uid || null };
}

export function matchesResourceRef(item: ResourceItem, ref: { kind: string; group?: string; apiVersion?: string; namespace?: string | null; name: string; uid?: string | null }): boolean {
  return item.kind === ref.kind && item.name === ref.name && (item.namespace ?? null) === (ref.namespace ?? null)
    && (ref.group === undefined || parseApiVersion(item.apiVersion).group === ref.group)
    && (!ref.apiVersion || parseApiVersion(item.apiVersion).group === parseApiVersion(ref.apiVersion).group)
    && (!ref.uid || item.uid === ref.uid);
}

export function resourceTabId(type: string, context: string | null, item: ResourceItem, container?: string): string {
  return JSON.stringify([type, context, resourceKey(item), item.uid, container ?? '']);
}
