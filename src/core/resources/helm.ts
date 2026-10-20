import type { HelmRelease } from '../../providers/helm_types';
import type { ResourceItem } from '../../types/k8s';

export function helmResource(context: string, release: HelmRelease): ResourceItem {
  return { kind: 'HelmRelease', apiVersion: 'helm.sh/v1', name: release.name, namespace: release.namespace,
    uid: JSON.stringify(['helm', context, release.namespace, release.name, release.revision]), status: release.status,
    raw: { release, context }, metadata: { name: release.name, namespace: release.namespace } };
}
