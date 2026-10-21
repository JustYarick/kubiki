import { resourceStatus } from '../core/resources/gitops';
import type { ResourceItem } from '../types/k8s';
import { stringify } from 'yaml';
import { resourceKey } from '../core/resources/identity';
import { formatAge } from '../core/utils/k8s_mapper';

export type CustomResourceInstance = ResourceItem;
export function parseCustomResources(raw: any): CustomResourceInstance[] {
  if (!Array.isArray(raw?.items)) throw new Error('Invalid custom resource list');
  return raw.items.map((item: any) => {
    if (!item?.metadata?.name || typeof item.kind !== 'string' || !item.kind || typeof item.apiVersion !== 'string' || !item.apiVersion) throw new Error('Invalid custom resource');
    const status = item.status ?? {};
    let yaml: string | undefined;
    const resource: ResourceItem = { uid: item.metadata.uid ?? resourceKey({ ...item, ...item.metadata }), name: item.metadata.name, namespace: item.metadata.namespace, kind: item.kind, apiVersion: item.apiVersion,
      raw: item, rawYaml: '', metadata: item.metadata, labels: item.metadata.labels ?? {}, spec: item.spec, statusRaw: status,
      creationTimestamp: item.metadata.creationTimestamp, age: item.metadata.creationTimestamp ? formatAge(item.metadata.creationTimestamp) : undefined,
      status: resourceStatus(item),
    };
    Object.defineProperty(resource, 'rawYaml', { enumerable: true, configurable: true, get: () => yaml ??= stringify(item) });
    return resource;
  });
}
