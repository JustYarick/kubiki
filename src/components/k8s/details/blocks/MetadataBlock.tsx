import { useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Info, Tag, ShieldAlert } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { toast } from '../../../../state/notifications_store';
import { Button } from '../../../ui/Button';
import { k8s } from '../../../../providers/k8s_provider';
import { useClusterStore } from '../../../../state/cluster_store';

interface MetadataBlockProps {
  item: ResourceItem;
  defaultExpanded?: boolean;
  onNavigate?: (item: ResourceItem) => void;
}

export function MetadataBlock({ item, defaultExpanded = false }: MetadataBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const raw = item.raw ?? {};
  const metadata = raw.metadata ?? item.metadata ?? {};
  const status = raw.status ?? item.statusRaw ?? {};

  const finalizers: string[] = metadata.finalizers ?? [];
  const deletionTimestamp = metadata.deletionTimestamp;
  const generation = metadata.generation;
  const observedGeneration = status.observedGeneration;
  const isReconciling = generation !== undefined && observedGeneration !== undefined && generation !== observedGeneration;

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => toast.success(`${label} copied`)).catch(() => toast.error('Clipboard unavailable'));
  };

  const removeFinalizer = async (finalizerName: string) => {
    try {
      if (k8s.demo) {
        toast.info('Demo: finalizer removed in memory');
        return;
      }
      const context = useClusterStore.getState().currentContext;
      if (!context) return;
      // Filter out the finalizer
      const remaining = finalizers.filter((f) => f !== finalizerName);
      toast.info(`Removing finalizer "${finalizerName}"...`);
      // Apply patch via kubectl or dynamic api
      const manifest = JSON.stringify({
        ...raw,
        apiVersion: item.apiVersion,
        kind: item.kind,
        metadata: {
          ...metadata,
          name: item.name,
          namespace: item.namespace,
          finalizers: remaining,
        },
      });
      await k8s.applyManifest(context, manifest, item);
      toast.success(`Finalizer "${finalizerName}" removed`);
    } catch (err) {
      toast.error('Failed to remove finalizer', String(err));
    }
  };

  return (
    <section aria-label="Metadata" className="details-section">
      <div
        onClick={() => setExpanded(!expanded)}
        className="details-section-heading text-[length:calc(11px*var(--ui-factor))] font-medium text-[var(--text-secondary)] bg-[var(--bg-secondary)] flex items-center justify-between cursor-pointer hover:bg-[var(--bg-hover)] transition-colors select-none"
      >
        <span className="flex items-center gap-1.5 text-[var(--text-primary)]">
          <Info size="calc(12px * var(--ui-factor))" className="text-[var(--text-muted)]" />
          Metadata & Object Spec
        </span>
        <div className="flex items-center gap-2">
          {finalizers.length > 0 && (
            <span className="text-[length:calc(10px*var(--ui-factor))] text-amber-400 font-mono bg-amber-500/10 px-1.5 py-0.5 rounded">
              {finalizers.length} finalizer(s)
            </span>
          )}
          {isReconciling && (
            <span className="text-[length:calc(10px*var(--ui-factor))] text-blue-400 font-mono bg-blue-500/10 px-1.5 py-0.5 rounded">
              Reconciling (gen {generation})
            </span>
          )}
          {expanded ? <ChevronDown size="calc(13px * var(--ui-factor))" /> : <ChevronRight size="calc(13px * var(--ui-factor))" />}
        </div>
      </div>

      {expanded && (
        <div className="p-2 flex flex-col gap-3 bg-[var(--bg-canvas)] text-xs">
          {/* Key metadata grid */}
          <dl className="details-properties">
            <dt className="text-[var(--text-secondary)]">Name</dt>
            <dd className="font-mono text-[var(--text-primary)] break-all flex items-center gap-2">
              <span>{item.name}</span>
              <button type="button" onClick={() => copy(item.name, 'Name')} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                <Copy size="calc(11px * var(--ui-factor))" />
              </button>
            </dd>

            <dt className="text-[var(--text-secondary)]">Namespace</dt>
            <dd className="font-mono text-[var(--text-primary)]">{item.namespace || 'Cluster scoped'}</dd>

            <dt className="text-[var(--text-secondary)]">UID</dt>
            <dd className="font-mono text-[var(--text-muted)] text-[10px] break-all flex items-center gap-2">
              <span>{item.uid}</span>
              <button type="button" onClick={() => copy(item.uid, 'UID')} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                <Copy size="calc(11px * var(--ui-factor))" />
              </button>
            </dd>

            <dt className="text-[var(--text-secondary)]">Created</dt>
            <dd className="font-mono text-[var(--text-secondary)]">
              {item.creationTimestamp ? `${new Date(item.creationTimestamp).toLocaleString()} (${item.age || '—'})` : '—'}
            </dd>

            {generation !== undefined && (
              <>
                <dt className="text-[var(--text-secondary)]">Generation</dt>
                <dd className="font-mono text-[var(--text-secondary)]">
                  {generation} {observedGeneration !== undefined ? `(observed: ${observedGeneration})` : ''}
                  {isReconciling && <span className="ml-2 text-blue-400 text-[10px]">Reconciliation in progress</span>}
                </dd>
              </>
            )}

            {deletionTimestamp && (
              <>
                <dt className="text-rose-400 font-medium">Deletion</dt>
                <dd className="font-mono text-rose-300">
                  {new Date(deletionTimestamp).toLocaleString()} (Terminating)
                </dd>
              </>
            )}
          </dl>

          {/* Finalizers */}
          {finalizers.length > 0 && (
            <div className="p-2 rounded bg-amber-950/20 border border-amber-500/20 flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-[length:calc(11px*var(--ui-factor))] font-semibold text-amber-300">
                <ShieldAlert size="calc(13px * var(--ui-factor))" />
                Finalizers ({finalizers.length})
              </div>
              <div className="text-[length:calc(10.5px*var(--ui-factor))] text-[var(--text-secondary)]">
                Prevent Kubernetes from deleting this resource until backend hooks complete:
              </div>
              <div className="space-y-1">
                {finalizers.map((fin) => (
                  <div key={fin} className="flex items-center justify-between p-1 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono text-[length:calc(10px*var(--ui-factor))]">
                    <span className="text-[var(--text-primary)]">{fin}</span>
                    <Button size="sm" onClick={() => void removeFinalizer(fin)} title="Remove this finalizer to unblock deletion">
                      Remove finalizer
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Labels */}
          {metadata.labels && Object.keys(metadata.labels).length > 0 && (
            <div>
              <div className="text-[length:calc(10.5px*var(--ui-factor))] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1 flex items-center gap-1.5">
                <Tag size="calc(12px * var(--ui-factor))" /> Labels
              </div>
              <div className="flex flex-wrap gap-1">
                {Object.entries(metadata.labels).map(([k, v]) => (
                  <span
                    key={k}
                    className="font-mono text-[length:calc(10px*var(--ui-factor))] px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-[var(--text-secondary)]"
                  >
                    <span className="text-[var(--text-muted)]">{k}:</span> {String(v)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Annotations */}
          {metadata.annotations && Object.keys(metadata.annotations).length > 0 && (
            <div>
              <div className="text-[length:calc(10.5px*var(--ui-factor))] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">
                Annotations ({Object.keys(metadata.annotations).length})
              </div>
              <div className="max-h-40 overflow-y-auto kubiki-scrollbar space-y-1">
                {Object.entries(metadata.annotations).map(([k, v]) => (
                  <div key={k} className="p-1 rounded bg-[var(--bg-secondary)]/50 text-[length:calc(10px*var(--ui-factor))] font-mono break-all">
                    <span className="text-[var(--text-muted)]">{k}:</span>
                    <span className="text-[var(--text-secondary)] ml-1">{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
