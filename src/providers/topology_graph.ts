import type { ResourceItem, ResourceKind } from '../types/k8s';
import type { ResourceRelation } from '../core/resources/relationships';
export interface TopologyGraphRequest { id: number; resources: Record<ResourceKind, Map<string, ResourceItem>>; scope: string; focus?: ResourceItem; depth: number }
export type TopologyGraphResponse = { id: number; keys: string[]; relations: ResourceRelation[] } | { id: number; error: string };

const graphResourceCache = new WeakMap<ResourceItem, ResourceItem>();

/**
 * Avoid evaluating the lazy rawYaml getter and strip heavy non-relational payloads
 * (ConfigMap/Secret data, containerStatuses, conditions, managedFields) before
 * structured-cloning resources to the topology worker.
 */
export function graphResource(item: ResourceItem): ResourceItem {
  const cached = graphResourceCache.get(item);
  if (cached) return cached;
  const raw = item.raw;
  const rawMeta = raw?.metadata ?? item.metadata;
  const metadata = rawMeta ? {
    name: rawMeta.name,
    namespace: rawMeta.namespace,
    uid: rawMeta.uid,
    labels: rawMeta.labels,
    annotations: rawMeta.annotations,
    ownerReferences: rawMeta.ownerReferences,
  } : undefined;
  const spec = raw?.spec ?? item.spec;
  const rawStatus = raw?.status ?? item.statusRaw;
  const status = rawStatus && (rawStatus.reservedFor || rawStatus.resourceClaimStatuses || rawStatus.inventory || rawStatus.resources) ? {
    reservedFor: rawStatus.reservedFor,
    resourceClaimStatuses: rawStatus.resourceClaimStatuses,
    inventory: rawStatus.inventory,
    resources: rawStatus.resources,
  } : undefined;
  const slimRaw = raw ? {
    metadata,
    spec,
    ...(status ? { status } : {}),
    ...(raw.endpoints ? { endpoints: raw.endpoints } : {}),
    ...(raw.subsets ? { subsets: raw.subsets } : {}),
    ...(raw.webhooks ? { webhooks: raw.webhooks } : {}),
    ...(raw.roleRef ? { roleRef: raw.roleRef } : {}),
    ...(raw.subjects ? { subjects: raw.subjects } : {}),
    ...(raw.secrets ? { secrets: raw.secrets } : {}),
    ...(raw.imagePullSecrets ? { imagePullSecrets: raw.imagePullSecrets } : {}),
    ...(raw.aggregationRule ? { aggregationRule: raw.aggregationRule } : {}),
  } : undefined;
  const projected: ResourceItem = {
    uid: item.uid,
    name: item.name,
    kind: item.kind,
    apiVersion: item.apiVersion,
    namespace: item.namespace,
    labels: item.labels,
    raw: slimRaw,
    metadata,
    spec,
    statusRaw: status,
    status: item.status,
    node: item.node,
    storageClass: item.storageClass,
    volume: item.volume,
  };
  graphResourceCache.set(item, projected);
  return projected;
}
