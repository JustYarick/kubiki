import { parseAllDocuments } from 'yaml';
import type { ResourceItem } from '../../types/k8s';
import { resourceIssues } from './diagnostics';
import { resourceKey } from './identity';
import type { HelmHistory, HelmRelease } from '../../providers/helm_types';
import { helmUpdatedAt } from '../../providers/helm_types';

export function releaseObjects(release: Pick<HelmRelease, 'name' | 'namespace'>, resources: Iterable<ResourceItem>): ResourceItem[] {
  return [...resources].filter(item => {
    const metadata = item.raw?.metadata ?? item.metadata ?? {};
    return metadata.labels?.['app.kubernetes.io/managed-by'] === 'Helm' && metadata.annotations?.['meta.helm.sh/release-name'] === release.name && metadata.annotations?.['meta.helm.sh/release-namespace'] === release.namespace;
  });
}
export function fluxReleaseOwner(release: Pick<HelmRelease, 'name' | 'namespace'>, resources: Iterable<ResourceItem>) {
  return [...resources].find(item => {
    if (item.kind !== 'HelmRelease' || !item.apiVersion.startsWith('helm.toolkit.fluxcd.io/')) return false;
    const spec = item.raw?.spec ?? {};
    const recorded = item.raw?.status?.history?.[0];
    const target = spec.targetNamespace ?? item.namespace;
    const name = spec.releaseName ?? recorded?.name ?? (target === item.namespace ? item.name : undefined);
    return name === release.name && (spec.storageNamespace ?? target) === release.namespace;
  });
}
export function helmOperation(release: HelmRelease, history: HelmHistory[] = [], now = Date.now()) {
  const latest = history.find(item => item.revision === Number(release.revision));
  const pending = release.status.startsWith('pending-') || release.status === 'uninstalling';
  // Updated is not an uninstall start time; never time an uninstall from an old deployment.
  const started = release.status.startsWith('pending-') ? helmUpdatedAt(latest?.updated || release.updated) : 0;
  const longRunning = pending && started > 0 && now >= started && now - started > 10 * 60000;
  const failed = release.status === 'failed';
  const label = failed ? 'Operation failed' : release.status === 'uninstalling' ? 'Uninstall in progress' : pending ? `${release.status.slice('pending-'.length)} in progress` : release.status;
  return { failed, pending, longRunning, label, started, message: latest?.description || (failed ? 'Helm marked the last operation as failed. Inspect resource conditions and hook Jobs to find the cause.' : longRunning ? 'This operation has been pending for over 10 minutes. Check readiness and hook Jobs before retrying.' : pending ? 'Helm is waiting for this operation to finish.' : '') };
}
export function parseReleaseManifest(manifest: string, namespace: string): ResourceItem[] {
  if (manifest.length > 8 * 1024 * 1024) throw new Error('Manifest is too large to inspect.');
  const output: ResourceItem[] = [];
  for (const document of parseAllDocuments(manifest)) {
    if (document.errors.length) throw new Error('The release contains invalid YAML.');
    const value = document.toJS({ maxAliasCount: 50 });
    for (const raw of value?.kind === 'List' ? value.items ?? [] : [value]) {
      if (raw == null) continue;
      if (typeof raw.kind !== 'string' || typeof raw.apiVersion !== 'string' || typeof raw.metadata?.name !== 'string') throw new Error('A rendered object is missing its identity.');
      // Cluster-scoped objects must not inherit the release namespace.
      const clusterKinds = new Set(['Namespace', 'Node', 'PersistentVolume', 'StorageClass', 'ClusterRole', 'ClusterRoleBinding', 'CustomResourceDefinition', 'IngressClass', 'PriorityClass', 'RuntimeClass', 'MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration']);
      const ns = raw.metadata.namespace ?? (clusterKinds.has(raw.kind) ? undefined : namespace);
      output.push({ kind: raw.kind, apiVersion: raw.apiVersion, name: raw.metadata.name, namespace: ns, uid: '', raw: { ...raw, metadata: { ...raw.metadata, namespace: ns } }, metadata: { ...raw.metadata, namespace: ns } });
      if (output.length > 10000) throw new Error('Too many rendered objects to inspect.');
    }
  }
  return output;
}
export function releaseHealth(expected: ResourceItem[], loaded: Iterable<ResourceItem>) {
  if (!expected.length) return [];
  const byKey = new Map([...loaded].map(item => [resourceKey(item), item]));
  return expected.map(reference => {
    const item = byKey.get(resourceKey(reference));
    const issues = item ? resourceIssues(item) : [];
    return { reference, item, issues, label: !item ? 'Not loaded' : issues.length ? issues[0].summary : item.status || 'Observed' };
  });
}
