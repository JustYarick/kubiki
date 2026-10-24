import type { ResourceItem } from '../../types/k8s';
import { parseApiVersion } from './resource_types';

export interface OwnerReference {
  uid?: string;
  name?: string;
  kind?: string;
  apiVersion?: string;
}

/**
 * Matches an ownerReference against a loaded resource.
 *
 * UIDs are authoritative whenever both sides have one. A name-only match is
 * only a fallback for incomplete objects, and it still requires the kind (and
 * API group when present) to agree. This prevents a recreated owner, or an
 * unrelated workload with the same name, from claiming a resource.
 */
export function ownerMatches(
  ref: OwnerReference | undefined | null,
  item: Pick<ResourceItem, 'uid' | 'name' | 'kind' | 'apiVersion'> | undefined,
  kind = ref?.kind,
): boolean {
  if (!ref || !item || !ref.kind || typeof ref.name !== 'string' || !item.name) return false;
  if (ref.kind !== item.kind || (kind !== undefined && ref.kind !== kind)) return false;
  if (
    ref.apiVersion &&
    item.apiVersion &&
    parseApiVersion(ref.apiVersion).group !== parseApiVersion(item.apiVersion).group
  ) {
    return false;
  }
  if (ref.uid && item.uid) return ref.uid === item.uid;
  return ref.name === item.name;
}
