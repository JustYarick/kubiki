import { useEffect, useState, type MouseEvent } from 'react';
import { ArrowRight, ExternalLink, KeyRound } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import type { SecretOrigin } from '../../../../core/resources/secret_origin';
import { resourceBucket } from '../../../../core/resources/custom_resource_types';
import { loadSecretOrigin } from '../../../../providers/secret_origin';
import { useClusterStore } from '../../../../state/cluster_store';
import { useResourceStore } from '../../../../state/resource_store';
import { toast } from '../../../../state/notifications_store';
import { Button } from '../../../ui/Button';

async function openVault(event: MouseEvent<HTMLAnchorElement>, url: string) {
  if (!('__TAURI_INTERNALS__' in window)) return;
  event.preventDefault();
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch { toast.error('Could not open Vault'); }
}

export function SecretOriginBlock({ item, onNavigate }: { item: ResourceItem; onNavigate: (item: ResourceItem) => void }) {
  const context = useClusterStore(state => state.currentContext);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ identity: string; origin: SecretOrigin }>();
  const identity = JSON.stringify([context, item.uid, item.namespace, item.name, item.raw?.metadata?.resourceVersion, attempt]);
  useEffect(() => {
    if (!context) return;
    const controller = new AbortController();
    void loadSecretOrigin(context, item, controller.signal).then(origin => {
      if (!controller.signal.aborted) setResult({ identity, origin });
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ identity, origin: { type: 'unknown', sources: [], incomplete: true } });
    });
    return () => controller.abort();
  }, [context, identity]);
  const origin = result?.identity === identity ? result.origin : undefined;
  const inspectSource = (resource: ResourceItem) => {
    const store = useResourceStore.getState();
    const bucket = resourceBucket(resource);
    const existing = store.resources[bucket]?.get(resource.uid);
    if (!existing) store.setResourcesForKind(bucket, [...(store.resources[bucket]?.values() ?? []), resource]);
    onNavigate(existing ?? resource);
  };
  const label = !context ? 'Source unavailable' : !origin ? 'Checking source…' : origin.type === 'internal' ? 'Internal · Kubernetes' : origin.type === 'external' ? 'External' : 'Source unknown';
  return <section aria-label="Secret source" className="details-section min-w-0">
    <div className="details-section-heading flex flex-wrap items-center gap-2 bg-[var(--bg-secondary)]">
      <KeyRound size={12} aria-hidden="true" className="text-[var(--accent)]" />
      <h3 className="text-xs font-medium flex-1">Secret source</h3>
      <span role="status" className="text-xs text-[var(--text-secondary)]">{label}</span>
      {origin?.incomplete && <Button size="sm" onClick={() => setAttempt(value => value + 1)}>Retry source lookup</Button>}
    </div>
    <div className="p-3 space-y-3 text-xs">
      {origin?.type === 'internal' && <p className="text-[var(--text-muted)]">Stored in Kubernetes. No External Secrets Operator or Vault Secrets Operator source was found.</p>}
      {origin?.sources.map((source, index) => <div key={index} className="space-y-2 min-w-0">
        <div className="flex flex-wrap gap-2 items-center">
          <span className="font-medium">{source.provider}</span>
          {source.resource && <Button size="sm" className="max-w-full h-auto py-1 break-all" aria-label={`Inspect ${source.resource.kind} ${source.resource.name} in ${source.resource.namespace ?? 'cluster'}`} title="Inspect the Kubernetes resource that syncs this Secret" onClick={() => inspectSource(source.resource!)}>{source.resource.kind}/{source.resource.name}<ArrowRight size={12} aria-hidden="true" /></Button>}
          {source.store && <span className="font-mono break-all text-[var(--text-secondary)]">{source.store}</span>}
        </div>
        {source.server && <p className="text-[var(--text-muted)]">Vault address: <span className="font-mono break-all text-[var(--text-secondary)]">{source.server}</span></p>}
        {source.locations.map((location, locationIndex) => <div key={locationIndex} className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
          <div className="min-w-0 flex-1 basis-40">
            <span className="text-[var(--text-muted)]">{source.provider === 'Vault' ? 'Vault path' : 'Remote path'}{location.folder ? ' (folder)' : ''}: </span>
            <span className="font-mono break-all">{location.path}</span>
            {location.key && <p className="text-[var(--text-secondary)] break-all">Key: <span className="font-mono">{location.key}</span>{location.property && <> · Property: <span className="font-mono">{location.property}</span></>}</p>}
          </div>
          {location.url && <a href={location.url} target="_blank" rel="noopener noreferrer" onClick={event => void openVault(event, location.url!)} className="inline-flex items-center gap-1 py-1 text-[var(--accent)] hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--focus-ring)]" aria-label={`Open ${location.path} in Vault`}>
            Open in Vault <ExternalLink size={12} aria-hidden="true" />
          </a>}
        </div>)}
        {!source.locations.length && <p className="text-[var(--text-muted)]">Path unavailable</p>}
        {source.note && <p className="text-[var(--text-muted)]">{source.note}</p>}
        {source.provider === 'Vault' && source.locations.length > 0 && !source.locations.some(location => location.url) && !source.note && <p className="text-[var(--text-muted)]">A direct Vault link is unavailable for this source or address.</p>}
      </div>)}
      {origin?.incomplete && <p className="text-[var(--text-muted)]">Some source metadata could not be read. Check access to the operator resources and CRDs.</p>}
      {!context && <p className="text-[var(--text-muted)]">Select a cluster to look up the source.</p>}
    </div>
  </section>;
}
