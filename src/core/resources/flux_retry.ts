import { parseApiVersion } from './resource_types';
import type { ResourceItem } from '../../types/k8s';

export function fluxHelmRetriesExceeded(item: ResourceItem): boolean {
  if (item.kind !== 'HelmRelease' || parseApiVersion(item.apiVersion).group !== 'helm.toolkit.fluxcd.io') return false;
  const generation = item.raw?.metadata?.generation;
  return (item.raw?.status?.conditions ?? []).some((condition: Record<string, unknown>) =>
    condition.reason === 'RetriesExceeded'
    && (condition.type === 'Stalled' && condition.status === 'True' || condition.type === 'Ready' && condition.status === 'False')
    && !(typeof generation === 'number' && typeof condition.observedGeneration === 'number' && condition.observedGeneration < generation));
}
