import { deletePath, patchManifest, setPath } from './manifest_helpers';
import type { ResourceCreatorModel } from './types';

export const POD_SECURITY_LEVELS = ['', 'privileged', 'baseline', 'restricted'] as const;
export type PodSecurityLevel = (typeof POD_SECURITY_LEVELS)[number];

const PSS_ENFORCE_LABEL = 'pod-security.kubernetes.io/enforce';

export interface NamespaceCreatorState {
  podSecurityEnforce: PodSecurityLevel;
}

export const namespaceCreatorModel: ResourceCreatorModel<NamespaceCreatorState> = {
  group: '',
  kind: 'Namespace',
  description: 'Isolate workloads, configuration, and access policies in a dedicated namespace.',
  defaultMetadataOpen: true,
  syncOnMetadataChange: true,

  fromObject(object) {
    const raw = object?.metadata?.labels?.[PSS_ENFORCE_LABEL];
    const level: PodSecurityLevel = POD_SECURITY_LEVELS.includes(raw) ? raw : '';
    return { podSecurityEnforce: level };
  },

  applyToManifest(manifest, state) {
    return patchManifest(manifest, (doc) => {
      if (state.podSecurityEnforce) {
        setPath(doc, ['metadata', 'labels', PSS_ENFORCE_LABEL], state.podSecurityEnforce);
      } else {
        deletePath(doc, ['metadata', 'labels', PSS_ENFORCE_LABEL]);
        const labels = doc.getIn(['metadata', 'labels']);
        if (labels && typeof labels === 'object' && 'items' in labels && Array.isArray((labels as { items: unknown[] }).items) && (labels as { items: unknown[] }).items.length === 0) {
          deletePath(doc, ['metadata', 'labels']);
        }
      }
    });
  },

  validate() {
    return '';
  },
};

export type AutomountOption = 'default' | 'true' | 'false';

export interface PullSecretEntry {
  id: number;
  name: string;
}

export interface ServiceAccountCreatorState {
  automountToken: AutomountOption;
  imagePullSecrets: PullSecretEntry[];
}

export const serviceAccountCreatorModel: ResourceCreatorModel<ServiceAccountCreatorState> = {
  group: '',
  kind: 'ServiceAccount',
  description: 'Provide an in-cluster identity and optional image pull secrets for Pods.',
  defaultMetadataOpen: true,

  fromObject(object) {
    const automountToken: AutomountOption =
      object.automountServiceAccountToken === true
        ? 'true'
        : object.automountServiceAccountToken === false
          ? 'false'
          : 'default';
    const rawSecrets = Array.isArray(object.imagePullSecrets) ? object.imagePullSecrets : [];
    const imagePullSecrets: PullSecretEntry[] = rawSecrets
      .map((entry: any, idx: number) => ({ id: idx + 1, name: typeof entry?.name === 'string' ? entry.name : '' }))
      .filter((entry) => entry.name);
    return { automountToken, imagePullSecrets };
  },

  applyToManifest(manifest, state) {
    return patchManifest(manifest, (doc) => {
      if (state.automountToken === 'true') setPath(doc, ['automountServiceAccountToken'], true);
      else if (state.automountToken === 'false') setPath(doc, ['automountServiceAccountToken'], false);
      else deletePath(doc, ['automountServiceAccountToken']);

      const names = state.imagePullSecrets.map((s) => s.name.trim()).filter(Boolean);
      if (names.length > 0) {
        setPath(doc, ['imagePullSecrets'], names.map((name) => ({ name })));
      } else {
        deletePath(doc, ['imagePullSecrets']);
      }
    });
  },

  validate(state) {
    const seen = new Set<string>();
    for (const secret of state.imagePullSecrets) {
      const name = secret.name.trim();
      if (!name) continue;
      if (seen.has(name)) return `Duplicate imagePullSecret "${name}".`;
      seen.add(name);
    }
    return '';
  },
};
