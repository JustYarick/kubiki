import type { ResourceItem } from '../../types/k8s';
import { gitOpsFamily, resourceStatus } from './gitops';

export type DeliveryState = 'healthy' | 'attention' | 'progressing' | 'suspended' | 'unknown';
export const deliveryLabels: Record<DeliveryState, string> = { healthy: 'Healthy', attention: 'Needs attention', progressing: 'In progress', suspended: 'Suspended', unknown: 'Unknown' };

/** Health and sync are independent: a healthy but out-of-sync app still needs attention. */
export function deliveryState(item: ResourceItem): DeliveryState {
  const raw = item.raw ?? {};
  const status = raw.status ?? {};
  if (raw.metadata?.deletionTimestamp) return 'progressing';
  if (raw.spec?.suspend === true) return 'suspended';
  if (gitOpsFamily(item) === 'argocd') {
    if (item.kind !== 'Application') return 'unknown';
    const health = status.health?.status;
    if (['Degraded', 'Missing'].includes(health) || status.sync?.status === 'OutOfSync' || ['Failed', 'Error'].includes(status.operationState?.phase)) return 'attention';
    if (['Running', 'Terminating'].includes(status.operationState?.phase) || health === 'Progressing') return 'progressing';
    if (health === 'Suspended') return 'suspended';
    return health === 'Healthy' && status.sync?.status === 'Synced' ? 'healthy' : 'unknown';
  }
  const conditions: any[] = Array.isArray(status.conditions) ? status.conditions : [];
  if (conditions.some(c => ['Stalled', 'Failed', 'Degraded'].includes(c.type) && c.status === 'True')) return 'attention';
  if (conditions.some(c => c.type === 'Reconciling' && c.status === 'True')) return 'progressing';
  const ready = conditions.find(c => c.type === 'Ready');
  const observed = ready?.observedGeneration ?? status.observedGeneration;
  if (observed != null && raw.metadata?.generation != null && observed < raw.metadata.generation) return 'progressing';
  return ready?.status === 'True' ? 'healthy' : ready?.status === 'False' ? 'attention' : 'unknown';
}

export function deliveryDescription(item: ResourceItem): string {
  const status = item.raw?.status ?? {};
  if (gitOpsFamily(item) === 'argocd' && item.kind === 'Application') return `${status.health?.status ?? 'Health unknown'} · ${status.sync?.status ?? 'Sync unknown'}`;
  return resourceStatus(item.raw ?? {}) ?? 'No readiness reported';
}

export function deliverySource(item: ResourceItem): string {
  const spec = item.raw?.spec ?? {};
  return spec.source?.repoURL || spec.sources?.map((source: any) => source.repoURL).filter(Boolean).join(', ') || spec.url || spec.chart?.spec?.sourceRef?.name || spec.sourceRef?.name || spec.chartRef?.name || spec.image || spec.endpoint || '—';
}

export function deliveryRevision(item: ResourceItem): string {
  const status = item.raw?.status ?? {};
  return status.sync?.revision || status.sync?.revisions?.join(', ') || status.lastAppliedRevision || status.artifact?.revision || status.lastAttemptedRevision || '—';
}

export type FluxCategory = 'kustomizations' | 'helmreleases' | 'sources' | 'automation' | 'notifications';
export function fluxCategory(item: Pick<ResourceItem, 'kind' | 'apiVersion'>): FluxCategory | undefined {
  if (gitOpsFamily(item) !== 'flux') return;
  if (item.kind === 'Kustomization') return 'kustomizations';
  if (item.kind === 'HelmRelease') return 'helmreleases';
  if (item.apiVersion.startsWith('source.')) return 'sources';
  if (item.apiVersion.startsWith('image.')) return 'automation';
  if (item.apiVersion.startsWith('notification.')) return 'notifications';
}
export function argoSync(item: ResourceItem): string {
  const status = item.raw?.status?.sync?.status;
  return ['Synced', 'OutOfSync'].includes(status) ? status : 'Unknown';
}
export function argoHealth(item: ResourceItem): string {
  const status = item.raw?.status?.health?.status;
  return ['Healthy', 'Progressing', 'Degraded', 'Suspended', 'Missing'].includes(status) ? status : 'Unknown';
}

/** A failed operation is distinct from a deliberately suspended reconciliation. */
export function deliveryReason(item: ResourceItem): string {
  const raw = item.raw ?? {};
  if (raw.metadata?.deletionTimestamp) return 'Deletion is in progress. Check finalizers and the owning controller if it does not complete.';
  if (raw.spec?.suspend || raw.status?.health?.status === 'Suspended') return 'Reconciliation is paused for this resource.';
  const operation = raw.status?.operationState;
  if (gitOpsFamily(item) === 'argocd') {
    if (['Failed', 'Error'].includes(operation?.phase) && operation.message) return operation.message;
    const condition = (raw.status?.conditions ?? []).find((entry: any) => /Error|Warning/.test(entry.type));
    if (condition?.message) return condition.message;
    if (argoHealth(item) === 'Degraded' || argoHealth(item) === 'Missing') return raw.status?.health?.message || `Managed resources are ${argoHealth(item).toLowerCase()}. Inspect the application to find the affected workload.`;
    if (argoSync(item) === 'OutOfSync') return 'Live resources differ from the target Git revision.';
    return operation?.message || deliveryDescription(item);
  }
  const conditions = raw.status?.conditions ?? [];
  const condition = conditions.find((entry: any) => ['Stalled', 'Failed', 'Degraded'].includes(entry.type) && entry.status === 'True')
    ?? conditions.find((entry: any) => entry.type === 'Ready' && entry.status === 'False')
    ?? conditions.find((entry: any) => entry.type === 'Reconciling' && entry.status === 'True');
  if (!condition && deliveryState(item) === 'progressing') return 'Waiting for the controller to observe the current resource generation.';
  return condition?.message || condition?.reason || deliveryDescription(item);
}

export function deliveryTimestamp(item: ResourceItem): { label: string; at: string } | undefined {
  const status = item.raw?.status ?? {};
  const operation = status.operationState;
  const candidates = gitOpsFamily(item) === 'argocd'
    ? [{ label: 'Sync finished', at: operation?.finishedAt }, { label: 'Sync started', at: operation?.startedAt }, { label: 'Last checked', at: status.reconciledAt }]
    : (status.conditions ?? []).filter((condition: any) => ['Ready', 'Reconciling', 'Stalled'].includes(condition.type)).map((condition: any) => ({ label: 'Status changed', at: condition.lastTransitionTime }));
  return candidates.find((candidate: any) => typeof candidate.at === 'string' && Number.isFinite(Date.parse(candidate.at)));
}
