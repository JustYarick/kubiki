import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { ResourceItem } from '../../types/k8s';
import { fluxHelmRetriesExceeded } from '../../core/resources/flux_retry';
import { performResourceAction } from '../../providers/resource_actions';
import { k8s } from '../../providers/k8s_provider';
import { useClusterStore } from '../../state/cluster_store';
import { toast } from '../../state/notifications_store';
import { Button } from '../ui/Button';

export function FluxHelmRetry({ item, onRequested }: { item: ResourceItem; onRequested?: () => void }) {
  const context = useClusterStore(state => state.currentContext);
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState<string>();
  if (!fluxHelmRetriesExceeded(item)) return null;
  const disabled = busy || requested === item.raw?.metadata?.resourceVersion || !context || !k8s.supportsHelmMutations || !item.raw?.metadata?.resourceVersion || item.raw?.spec?.suspend === true || !!item.raw?.metadata?.deletionTimestamp;
  const retry = async () => {
    if (disabled || !context) return;
    setBusy(true);
    try {
      await performResourceAction(context, item, { type: 'flux_retry' });
      setRequested(item.raw?.metadata?.resourceVersion);
      onRequested?.();
    } catch (error) {
      if ((error as { code?: string }).code !== 'cancelled') toast.error('Failed to request Flux Helm retry', error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };
  return <div className="details-actions-row flex-wrap">
    <p className="details-caption flex-1 min-w-0">Flux exhausted its remediation retries.{item.raw?.spec?.suspend ? ' Resume this HelmRelease before retrying.' : ' Retry resets the failure count and requests reconciliation.'}</p>
    <Button size="sm" loading={busy} disabled={disabled} onClick={() => void retry()}><RotateCcw size={12} aria-hidden="true" />{requested === item.raw?.metadata?.resourceVersion ? 'Retry requested' : 'Retry Helm release'}</Button>
  </div>;
}
