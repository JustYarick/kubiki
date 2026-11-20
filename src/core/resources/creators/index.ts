import type { NewResourceType } from '../new_resource';
import { configMapCreatorModel } from './configmap_creator';
import { namespaceCreatorModel, serviceAccountCreatorModel } from './metadata_creators';
import { ingressCreatorModel, pvcCreatorModel, serviceCreatorModel } from './network_storage_creators';
import { secretCreatorModel } from './secret_creator';
import type { ResourceCreatorModel } from './types';
import { cronJobCreatorModel, deploymentCreatorModel, jobCreatorModel, podCreatorModel } from './workload_creators';

export * from './types';
export * from './manifest_helpers';
export * from './secret_creator';
export * from './configmap_creator';
export * from './metadata_creators';
export * from './workload_creators';
export * from './network_storage_creators';

export const RESOURCE_CREATOR_MODELS: readonly ResourceCreatorModel<any>[] = [
  secretCreatorModel,
  configMapCreatorModel,
  namespaceCreatorModel,
  serviceAccountCreatorModel,
  deploymentCreatorModel,
  podCreatorModel,
  serviceCreatorModel,
  ingressCreatorModel,
  pvcCreatorModel,
  jobCreatorModel,
  cronJobCreatorModel,
];

/** Exact `(group, kind)` lookup key so CRDs with colliding kinds never hijack core forms. */
export function creatorRegistryKey(group: string, kind: string): string {
  return `${group}/${kind}`;
}

const MODEL_MAP = new Map<string, ResourceCreatorModel<any>>(
  RESOURCE_CREATOR_MODELS.map((model) => [creatorRegistryKey(model.group, model.kind), model]),
);

export function findCreatorModel(type: Pick<NewResourceType, 'group' | 'kind'>): ResourceCreatorModel<any> | undefined {
  return MODEL_MAP.get(creatorRegistryKey(type.group, type.kind));
}
