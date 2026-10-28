import { mapK8sResource } from '../../core/utils/k8s_mapper';
import { resourceBucket } from '../../core/resources/custom_resource_types';
import type { ResourceItem } from '../../types/k8s';

/** A connected GitOps fixture: source failures, drift, operations, hooks and healthy apps. */
export function buildMockDelivery() {
  const now = Date.now();
  const at = (minutes: number) => new Date(now - minutes * 60000).toISOString();
  const version = (group: string) => group === 'argoproj.io' ? 'v1alpha1' : group === 'helm.toolkit.fluxcd.io' ? 'v2' : 'v1';
  const object = (group: string, kind: string, name: string, namespace: string, spec: any, status: any, age = 60): ResourceItem => mapK8sResource({ apiVersion: `${group}/${version(group)}`, kind, metadata: { name, namespace, uid: `demo-${group}-${kind}-${namespace}-${name}`, creationTimestamp: at(age), generation: 2, resourceVersion: '1' }, spec, status }, kind);
  const definitions: ResourceItem[] = [];
  const custom: Record<string, ResourceItem[]> = {};
  const conditions = (ready: boolean, message: string, reason = ready ? 'ReconciliationSucceeded' : 'ReconciliationFailed', minutes = 4) => [{ type: 'Ready', status: ready ? 'True' : 'False', reason, message, observedGeneration: 2, lastTransitionTime: at(minutes) }];
  const add = (group: string, kind: string, plural: string, entries: ResourceItem[]) => {
    definitions.push(mapK8sResource({ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: `${plural}.${group}`, uid: `demo-crd-${plural}`, creationTimestamp: at(10080) }, spec: { group, names: { kind, plural, singular: kind.toLowerCase() }, scope: 'Namespaced', versions: [{ name: version(group), served: true, storage: true }] } }, 'CustomResourceDefinition'));
    custom[resourceBucket({ kind, apiVersion: `${group}/${version(group)}` })] = entries;
  };
  const source = 'source.toolkit.fluxcd.io';
  add(source, 'GitRepository', 'gitrepositories', [
    object(source, 'GitRepository', 'platform', 'flux-system', { url: 'https://github.com/acme/platform', interval: '1m', ref: { branch: 'main' } }, { conditions: conditions(true, 'Fetched main@sha1:6e983a1'), artifact: { revision: 'main@sha1:6e983a1' } }),
    object(source, 'GitRepository', 'payments', 'backend', { url: 'https://github.com/acme/payments', interval: '1m' }, { conditions: conditions(false, 'Authentication failed while fetching repository: SSH key was rejected.', 'GitOperationFailed', 12) }),
    object(source, 'GitRepository', 'frontend', 'frontend', { url: 'https://github.com/acme/web', interval: '2m' }, { conditions: conditions(true, 'Fetched main@sha1:a51d286', undefined, 8), artifact: { revision: 'main@sha1:a51d286' } }),
  ]);
  add(source, 'HelmRepository', 'helmrepositories', [object(source, 'HelmRepository', 'platform-charts', 'flux-system', { url: 'https://charts.example.com', interval: '5m' }, { conditions: conditions(true, 'Chart index is up to date.') })]);
  add(source, 'OCIRepository', 'ocirepositories', [object(source, 'OCIRepository', 'observability', 'monitoring', { url: 'oci://ghcr.io/acme/observability', interval: '5m' }, { conditions: conditions(true, 'Fetched OCI artifact.'), artifact: { revision: 'v2.6.0@sha256:3c7d2e1' } })]);
  const kustomize = 'kustomize.toolkit.fluxcd.io';
  add(kustomize, 'Kustomization', 'kustomizations', [
    object(kustomize, 'Kustomization', 'platform', 'flux-system', { sourceRef: { kind: 'GitRepository', name: 'platform' }, path: './clusters/demo', interval: '5m' }, { conditions: conditions(true, 'Applied revision main@sha1:6e983a1'), lastAppliedRevision: 'main@sha1:6e983a1', inventory: { entries: [{ id: 'default_api-gateway_apps_Deployment', v: 'v1' }] } }),
    object(kustomize, 'Kustomization', 'payments', 'backend', { sourceRef: { kind: 'GitRepository', name: 'payments' }, path: './deploy', interval: '2m' }, { conditions: conditions(false, 'Source GitRepository/backend/payments is not ready: authentication failed.', 'ArtifactFailed', 11), lastAppliedRevision: 'main@sha1:42eb209' }),
    object(kustomize, 'Kustomization', 'web', 'frontend', { sourceRef: { kind: 'GitRepository', name: 'frontend' }, path: './production', interval: '5m' }, { conditions: conditions(true, 'Applied main@sha1:a51d286', undefined, 8), lastAppliedRevision: 'main@sha1:a51d286' }),
    object(kustomize, 'Kustomization', 'staging-preview', 'staging', { sourceRef: { kind: 'GitRepository', name: 'platform', namespace: 'flux-system' }, suspend: true }, { conditions: conditions(true, 'Last applied before suspension.', undefined, 25), lastAppliedRevision: 'main@sha1:918c470' }),
    object(kustomize, 'Kustomization', 'logging', 'logging', { sourceRef: { kind: 'GitRepository', name: 'platform', namespace: 'flux-system' }, path: './logging' }, { conditions: [{ type: 'Reconciling', status: 'True', reason: 'Progressing', message: 'Waiting for Loki StatefulSet to become ready.', lastTransitionTime: at(1) }], lastAttemptedRevision: 'main@sha1:6e983a1' }),
  ]);
  const helm = 'helm.toolkit.fluxcd.io';
  add(helm, 'HelmRelease', 'helmreleases', [
    object(helm, 'HelmRelease', 'prometheus', 'monitoring', { releaseName: 'prometheus', chart: { spec: { chart: 'kube-prometheus-stack', version: '65.1.0', sourceRef: { kind: 'HelmRepository', name: 'platform-charts', namespace: 'flux-system' } } } }, { conditions: conditions(true, 'Helm upgrade succeeded.'), lastAttemptedRevision: '65.1.0' }),
    object(helm, 'HelmRelease', 'redis-cache', 'backend', { releaseName: 'redis-cache', chart: { spec: { chart: 'redis', version: '20.1.0', sourceRef: { kind: 'HelmRepository', name: 'platform-charts', namespace: 'flux-system' } } } }, { conditions: conditions(true, 'Release is ready.'), lastAttemptedRevision: '20.1.0' }),
    object(helm, 'HelmRelease', 'loki', 'logging', { releaseName: 'loki', chart: { spec: { chart: 'loki', version: '6.0.0', sourceRef: { kind: 'HelmRepository', name: 'platform-charts', namespace: 'flux-system' } } } }, { conditions: conditions(false, 'Upgrade failed: pre-upgrade hook Job loki-migrate failed.', 'UpgradeFailed', 6), lastAttemptedRevision: '6.0.0' }),
  ]);
  const image = 'image.toolkit.fluxcd.io';
  add(image, 'ImageRepository', 'imagerepositories', [object(image, 'ImageRepository', 'web', 'frontend', { image: 'ghcr.io/acme/web' }, { conditions: conditions(true, 'Scanned 24 image tags.') })]);
  add(image, 'ImagePolicy', 'imagepolicies', [object(image, 'ImagePolicy', 'web', 'frontend', { imageRepositoryRef: { name: 'web' }, policy: { semver: { range: '>=1.0.0' } } }, { conditions: conditions(true, 'Latest image selected.') })]);
  const argo = 'argoproj.io';
  const apps = [
    ['api-gateway', 'default', 'Healthy', 'Synced', 'Succeeded', 4],
    ['payment-worker', 'backend', 'Degraded', 'Synced', 'Failed', 12],
    ['web-frontend', 'frontend', 'Healthy', 'OutOfSync', 'Succeeded', 8],
    ['auth-service', 'backend', 'Progressing', 'OutOfSync', 'Running', 1],
    ['staging-api', 'staging', 'Healthy', 'Synced', 'Succeeded', 20],
    ['missing-service', 'staging', 'Missing', 'OutOfSync', 'Error', 15],
  ] as const;
  add(argo, 'Application', 'applications', apps.map(([name, ns, health, sync, phase, ago]) => object(argo, 'Application', name, 'argocd', { project: ns === 'staging' ? 'staging' : 'production', source: { repoURL: `https://github.com/acme/${name}`, targetRevision: 'main', path: 'deploy' }, destination: { server: 'https://kubernetes.default.svc', namespace: ns }, syncPolicy: { automated: { selfHeal: true, prune: false } } }, { health: { status: health }, sync: { status: sync, revision: `${name.slice(0, 3)}6e983a1` }, operationState: { phase, startedAt: at(ago), ...(phase === 'Running' ? {} : { finishedAt: at(ago - .5) }), message: phase === 'Failed' ? 'Deployment payment-worker exceeded its progress deadline.' : phase === 'Error' ? 'Repository path deploy could not be found.' : phase === 'Running' ? 'Applying Deployment auth-service.' : 'Sync completed successfully.' }, reconciledAt: at(ago), resources: [{ group: 'apps', version: 'v1', kind: 'Deployment', namespace: ns, name, status: sync, health: { status: health } }] }, ago)));
  add(argo, 'AppProject', 'appprojects', ['production', 'staging'].map(name => object(argo, 'AppProject', name, 'argocd', { description: `${name} applications`, sourceRepos: ['https://github.com/acme/*'], destinations: [{ server: 'https://kubernetes.default.svc', namespace: '*' }] }, {})));
  add(argo, 'ApplicationSet', 'applicationsets', [object(argo, 'ApplicationSet', 'preview-environments', 'argocd', { generators: [{ list: { elements: [{ cluster: 'demo', namespace: 'staging' }] } }] }, { conditions: [{ type: 'ResourcesUpToDate', status: 'True', reason: 'ApplicationSetUpToDate', message: 'Generated preview applications are up to date.', lastTransitionTime: at(3) }] })]);
  const events: ResourceItem[] = [];
  for (const item of Object.values(custom).flat()) {
    const condition = item.raw?.status?.conditions?.[0];
    const operation = item.raw?.status?.operationState;
    if (!condition && !operation) continue;
    const warning = condition?.status === 'False' || ['Failed', 'Error'].includes(operation?.phase);
    const time = condition?.lastTransitionTime ?? operation?.finishedAt ?? operation?.startedAt ?? at(3);
    events.push(mapK8sResource({ apiVersion: 'v1', kind: 'Event', metadata: { name: `${item.name}-${item.kind.toLowerCase()}-reconcile`, namespace: item.namespace, uid: `demo-event-${item.uid}`, creationTimestamp: time }, involvedObject: { apiVersion: item.apiVersion, kind: item.kind, name: item.name, namespace: item.namespace, uid: item.uid }, type: warning ? 'Warning' : 'Normal', reason: condition?.reason ?? operation?.phase, message: condition?.message ?? operation?.message, lastTimestamp: time, count: warning ? 3 : 1 }, 'Event'));
  }
  return { definitions, custom, events };
}
