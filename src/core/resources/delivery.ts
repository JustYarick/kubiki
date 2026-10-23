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
