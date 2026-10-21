import { useMemo } from 'react';
import { History, RotateCcw, Check } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { useResourceStore } from '../../../../state/resource_store';
import { useClusterStore } from '../../../../state/cluster_store';
import { k8s } from '../../../../providers/k8s_provider';
import { stringify } from 'yaml';
import { Button } from '../../../ui/Button';
import { toast } from '../../../../state/notifications_store';

interface RevisionHistoryBlockProps {
  workload?: ResourceItem;
  item?: ResourceItem;
}

export function RevisionHistoryBlock({ workload, item }: RevisionHistoryBlockProps) {
  const targetWorkload = workload ?? item;
  const replicaSets = useResourceStore((s) => s.resources.ReplicaSet);

  // Find ReplicaSets owned by this workload
  const revisions = useMemo(() => {
    if (!targetWorkload || !['Deployment'].includes(targetWorkload.kind)) return [];

    const owned: ResourceItem[] = [];
    for (const rs of replicaSets.values()) {
      if (rs.namespace === targetWorkload.namespace) {
        const owners = rs.raw?.metadata?.ownerReferences ?? [];
        if (owners.some((o: any) => o.kind === targetWorkload.kind && (o.name === targetWorkload.name || o.uid === targetWorkload.uid))) {
          owned.push(rs);
        }
      }
    }

    // Sort by revision annotation descending
    return owned.sort((a, b) => {
      const revA = Number(a.raw?.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? 0);
      const revB = Number(b.raw?.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? 0);
      return revB - revA;
    });
  }, [replicaSets, targetWorkload]);

  if (!targetWorkload || revisions.length === 0) return null;

  const rollback = async (rs: ResourceItem) => {
    const rev = rs.raw?.metadata?.annotations?.['deployment.kubernetes.io/revision'] || 'previous';
    const targetTemplate = rs.raw?.spec?.template;
    if (!targetTemplate) {
      toast.error('Cannot rollback: revision template is missing');
      return;
    }
    const currentContext = useClusterStore.getState().currentContext;
    if (!currentContext && !k8s.demo) {
      toast.error('No active cluster context');
      return;
    }
    const updatedRaw = {
      ...targetWorkload.raw,
      spec: {
        ...(targetWorkload.raw?.spec ?? {}),
        template: targetTemplate,
      },
    };
    try {
      if (k8s.demo) {
        useResourceStore.getState().updateItem(targetWorkload.kind, targetWorkload.uid, {
          ...targetWorkload,
          raw: updatedRaw,
        });
        toast.success(`Rolled back ${targetWorkload.name} to revision #${rev} (demo)`);
      } else {
        await k8s.applyManifest(currentContext!, stringify(updatedRaw), targetWorkload);
        toast.success(`Rollback to revision #${rev} applied for ${targetWorkload.name}`);
      }
    } catch (err: any) {
      if (err?.code === 'cancelled') {
        toast.info('Rollback cancelled');
      } else {
        toast.error('Failed to rollback deployment', String(err?.message || err));
      }
    }
  };

  return (
    <section aria-label="Revision history" className="details-section">
      <div className="details-section-heading text-[length:calc(11px*var(--ui-factor))] font-medium text-[var(--text-secondary)] bg-[var(--bg-secondary)] flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[var(--text-primary)]">
          <History size="calc(12px * var(--ui-factor))" className="text-[var(--accent)]" />
          Revision History ({revisions.length} revisions)
        </span>
      </div>

      <div className="p-2 space-y-1.5 bg-[var(--bg-canvas)]">
        {revisions.map((rs, index) => {
          const revNum = rs.raw?.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? (revisions.length - index);
          const isCurrent = index === 0;
          const image = rs.raw?.spec?.template?.spec?.containers?.[0]?.image ?? '—';

          return (
            <div
              key={rs.uid}
              className={`p-2 rounded border transition-colors flex items-center gap-2 text-xs ${
                isCurrent
                  ? 'bg-[var(--bg-secondary)]/80 border-[var(--accent)]/40'
                  : 'bg-[var(--bg-secondary)]/30 border-[var(--border-subtle)]'
              }`}
            >
              <div className="flex flex-col flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-[var(--text-primary)]">
                    #{revNum}
                  </span>
                  {isCurrent && (
                    <span className="flex items-center gap-0.5 text-[length:calc(10px*var(--ui-factor))] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded font-medium">
                      <Check size="calc(10px * var(--ui-factor))" /> Current revision
                    </span>
                  )}
                  <span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] font-mono truncate">
                    {rs.name}
                  </span>
                </div>
                <div className="font-mono text-[length:calc(10.5px*var(--ui-factor))] text-[var(--text-secondary)] mt-0.5 truncate">
                  Image: {image}
                </div>
                <div className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] mt-0.5">
                  Created {rs.age || 'recently'} · Replicas: {rs.ready || '0'}
                </div>
              </div>

              {!isCurrent && (
                <Button size="sm" onClick={() => rollback(rs)} title="Rollback deployment to this revision">
                  <RotateCcw size="calc(11px * var(--ui-factor))" />
                  Rollback
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
