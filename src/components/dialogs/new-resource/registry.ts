import type { NewResourceType } from '../../../core/resources/new_resource';
import {
  configMapCreatorModel,
  creatorRegistryKey,
  cronJobCreatorModel,
  deploymentCreatorModel,
  ingressCreatorModel,
  jobCreatorModel,
  namespaceCreatorModel,
  podCreatorModel,
  pvcCreatorModel,
  secretCreatorModel,
  serviceAccountCreatorModel,
  serviceCreatorModel,
} from '../../../core/resources/creators';
import { ConfigMapCreatorForm } from './creators/ConfigMapCreatorForm';
import { NamespaceCreatorForm, ServiceAccountCreatorForm } from './creators/MetadataCreatorForms';
import { IngressCreatorForm, PvcCreatorForm, ServiceCreatorForm } from './creators/NetworkStorageCreatorForms';
import { SecretCreatorForm } from './creators/SecretCreatorForm';
import { CronJobCreatorForm, DeploymentCreatorForm, JobCreatorForm, PodCreatorForm } from './creators/WorkloadCreatorForms';
import type { RegisteredResourceCreator } from './types';

/**
 * Registry of specialized interactive resource creator forms.
 * Lookup uses exact `(group, kind)` identity so custom resources with colliding
 * kinds fall back cleanly to the generic YAML editor instead of misapplying a
 * core schema.
 */
const REGISTERED_CREATORS: readonly RegisteredResourceCreator[] = [
  { model: secretCreatorModel, Form: SecretCreatorForm },
  { model: configMapCreatorModel, Form: ConfigMapCreatorForm },
  { model: namespaceCreatorModel, Form: NamespaceCreatorForm },
  { model: serviceAccountCreatorModel, Form: ServiceAccountCreatorForm },
  { model: deploymentCreatorModel, Form: DeploymentCreatorForm },
  { model: podCreatorModel, Form: PodCreatorForm },
  { model: serviceCreatorModel, Form: ServiceCreatorForm },
  { model: ingressCreatorModel, Form: IngressCreatorForm },
  { model: pvcCreatorModel, Form: PvcCreatorForm },
  { model: jobCreatorModel, Form: JobCreatorForm },
  { model: cronJobCreatorModel, Form: CronJobCreatorForm },
];

const CREATOR_MAP = new Map<string, RegisteredResourceCreator>(
  REGISTERED_CREATORS.map((creator) => [creatorRegistryKey(creator.model.group, creator.model.kind), creator]),
);

/** Return the registered interactive creator for `type`, or `undefined` to fall back to YAML. */
export function resolveResourceCreator(type: Pick<NewResourceType, 'group' | 'kind'>): RegisteredResourceCreator | undefined {
  return CREATOR_MAP.get(creatorRegistryKey(type.group, type.kind));
}
