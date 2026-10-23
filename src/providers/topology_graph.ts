import type { ResourceItem, ResourceKind } from '../types/k8s';
import type { ResourceRelation } from '../core/resources/relationships';
export interface TopologyGraphRequest { id: number; resources: Record<ResourceKind, Map<string, ResourceItem>>; scope: string; focus?: ResourceItem; depth: number }
export type TopologyGraphResponse = { id: number; keys: string[]; relations: ResourceRelation[] } | { id: number; error: string };
/** Avoid evaluating the lazy rawYaml getter when posting resources to a worker. */
export function graphResource(item: ResourceItem): ResourceItem {
  return { uid: item.uid, name: item.name, kind: item.kind, apiVersion: item.apiVersion, namespace: item.namespace, labels: item.labels, raw: item.raw, metadata: item.metadata, spec: item.spec, statusRaw: item.statusRaw, status: item.status, node: item.node, storageClass: item.storageClass, volume: item.volume };
}
