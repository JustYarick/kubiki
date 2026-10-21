import type { CustomResourceType } from './custom_resource_types';
import type { ResourceItem } from '../../types/k8s';
import { parseApiVersion } from './resource_types';

export function gitOpsFamily(item: { group: string; kind: string } | Pick<ResourceItem, 'apiVersion' | 'kind'>): 'flux' | 'argocd' | undefined {
  const group = 'group' in item ? item.group : parseApiVersion(item.apiVersion).group;
  if (group.endsWith('.toolkit.fluxcd.io') || group === 'fluxcd.io') return 'flux';
  if (group === 'argoproj.io' && ['Application', 'ApplicationSet', 'AppProject'].includes(item.kind)) return 'argocd';
}
export function gitOpsGroup(type: CustomResourceType): string {
  if (type.group.startsWith('source.')) return 'Sources';
  if (type.group.startsWith('image.')) return 'Image Automation';
  if (type.group.startsWith('notification.')) return 'Notifications';
  return 'Delivery';
}

export interface GitOpsReference { kind: string; name: string; namespace?: string; group?: string; version?: string; local?: boolean }
/** References are controller-reported inventory or explicit spec fields, never name guesses. */
export function gitOpsReferences(item: ResourceItem): { sources: GitOpsReference[]; managed: GitOpsReference[] } {
  const raw = item.raw ?? {};
  const spec = raw.spec ?? {};
  const sources: GitOpsReference[] = [];
  const managed: GitOpsReference[] = [];
  if (gitOpsFamily(item) === 'flux') {
    for (const ref of [spec.sourceRef, spec.chart?.spec?.sourceRef, spec.chartRef, ...(spec.dependsOn ?? [])]) {
      if (ref?.name) sources.push({ kind: ref.kind ?? item.kind, name: ref.name, namespace: ref.namespace ?? item.namespace, group: ref.apiVersion?.split('/')[0] });
    }
    for (const name of [spec.secretRef?.name, spec.decryption?.secretRef?.name, spec.kubeConfig?.secretRef?.name]) {
      if (name) sources.push({ kind: 'Secret', name, namespace: item.namespace, group: '' });
    }
    for (const ref of spec.valuesFrom ?? []) if (ref?.name) sources.push({ kind: ref.kind ?? 'Secret', name: ref.name, namespace: item.namespace, group: '' });
    if (spec.imageRepositoryRef?.name) sources.push({ kind: 'ImageRepository', name: spec.imageRepositoryRef.name, namespace: spec.imageRepositoryRef.namespace ?? item.namespace, group: 'image.toolkit.fluxcd.io' });
    if (spec.providerRef?.name) sources.push({ kind: 'Provider', name: spec.providerRef.name, namespace: item.namespace, group: 'notification.toolkit.fluxcd.io' });
    for (const ref of spec.healthChecks ?? []) if (ref.kind && ref.name) sources.push({ kind: ref.kind, name: ref.name, namespace: ref.namespace ?? item.namespace, group: ref.apiVersion?.includes('/') ? ref.apiVersion.split('/')[0] : '' });
    for (const entry of raw.status?.inventory?.entries ?? []) {
      const [namespace, name, group, kind] = String(entry.id ?? '').split('_');
      if (name && kind) managed.push({ kind, name, namespace: namespace || undefined, group, version: entry.v });
    }
  } else if (gitOpsFamily(item) === 'argocd') {
    if (spec.project) sources.push({ kind: 'AppProject', name: spec.project, namespace: item.namespace, group: 'argoproj.io' });
    for (const entry of raw.status?.resources ?? []) {
      if (entry.kind && entry.name) managed.push({ kind: entry.kind, name: entry.name, namespace: entry.namespace, group: entry.group ?? '', version: entry.version, local: spec.destination?.server === 'https://kubernetes.default.svc' || spec.destination?.name === 'in-cluster' });
    }
  }
  return { sources, managed };
}

export function resolveGitOpsReference(reference: GitOpsReference, items: Iterable<ResourceItem>): ResourceItem | undefined {
  if (reference.local === false) return;
  for (const item of items) {
    const group = parseApiVersion(item.apiVersion).group;
    if (item.kind === reference.kind && item.name === reference.name && item.namespace === reference.namespace && (reference.group !== undefined ? reference.group === group : gitOpsFamily(item) === 'flux')) return item;
  }
}
export function resourceStatus(raw: any): string | undefined {
  if (raw.metadata?.deletionTimestamp) return 'Terminating';
  if (raw.spec?.suspend === true) return 'Suspended';
  const status = raw.status ?? {};
  if (typeof status.health?.status === 'string') return status.health.status;
  if (typeof status.sync?.status === 'string') return status.sync.status;
  const conditions: any[] = Array.isArray(status.conditions) ? status.conditions : [];
  const negative = conditions.find(condition => ['Failed', 'Degraded', 'Stalled', 'Denied'].includes(condition.type) && condition.status === 'True');
  if (negative) return negative.reason || negative.type;
  const reconciling = conditions.find(condition => condition.type === 'Reconciling' && condition.status === 'True');
  if (reconciling) return 'Reconciling';
  const ready = conditions.find(condition => ['Ready', 'Available', 'Established', 'ScalingActive', 'Healthy'].includes(condition.type));
  return status.phase || status.state || (ready ? ready.status === 'True' ? 'Ready' : ready.reason || (ready.status === 'False' ? 'NotReady' : 'Unknown') : undefined);
}
