import { performResourceAction, restartManifest } from '../../../../providers/resource_actions';
import { useState } from 'react';
import { Layers, Activity, Users, Plus, Minus, RotateCw } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { useResourceStore } from '../../../../state/resource_store';
import { useClusterStore } from '../../../../state/cluster_store';
import { k8s } from '../../../../providers/k8s_provider';
import { toast } from '../../../../state/notifications_store';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { ContainerCard } from '../blocks/ContainerCard';
import { RevisionHistoryBlock } from '../blocks/RevisionHistoryBlock';
import { ConditionsTable } from '../blocks/ConditionsTable';
import { MetadataBlock } from '../blocks/MetadataBlock';
import { Button } from '../../../ui/Button';

interface WorkloadDetailsProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
  onLogs: (container?: string) => void;
  onShell: (container?: string) => void;
}

export function WorkloadDetails({ item, onNavigate, onLogs, onShell }: WorkloadDetailsProps) {
  const resources = useResourceStore((s) => s.resources);
  const currentContext = useClusterStore((s) => s.currentContext);
  const raw = item.raw ?? {};
  const spec = raw.spec ?? item.spec ?? {};
  const status = raw.status ?? item.statusRaw ?? {};

  const desiredReplicas: number = spec.replicas ?? (item.kind === 'DaemonSet' ? (status.desiredNumberScheduled ?? 0) : 1);
  const readyReplicas: number = status.readyReplicas ?? status.numberReady ?? 0;
  const availableReplicas: number = status.availableReplicas ?? status.numberAvailable ?? 0;
  const updatedReplicas: number = status.updatedReplicas ?? status.updatedNumberScheduled ?? 0;

  // Scaling state
  const [targetReplicas, setTargetReplicas] = useState<number>(desiredReplicas);
  const [scaling, setScaling] = useState(false);

  // Pod template
  const templateSpec = spec.template?.spec ?? {};
  const templateContainers: any[] = templateSpec.containers ?? [];

  // Find child pods matching workload
  const pods = [...resources.Pod.values()].filter((pod) => {
    if (item.namespace && pod.namespace !== item.namespace) return false;
    const owners = pod.raw?.metadata?.ownerReferences ?? [];
    if (owners.some((o: any) => o.name === item.name || o.uid === item.uid)) return true;

    // For Deployments, pod owner is ReplicaSet, whose owner is Deployment
    if (item.kind === 'Deployment') {
      const rsOwners = owners.filter((o: any) => o.kind === 'ReplicaSet');
      for (const rsRef of rsOwners) {
        const rs = [...resources.ReplicaSet.values()].find((r) => r.name === rsRef.name && r.namespace === pod.namespace);
        const rsGrandowners = rs?.raw?.metadata?.ownerReferences ?? [];
        if (rsGrandowners.some((o: any) => o.name === item.name || o.uid === item.uid)) return true;
      }
    }

    // Match by selector labels
    const matchLabels = spec.selector?.matchLabels;
    if (matchLabels && Object.keys(matchLabels).length > 0) {
      const podLabels = pod.labels ?? pod.raw?.metadata?.labels ?? {};
      return Object.entries(matchLabels).every(([k, v]) => podLabels[k] === v);
    }

    return false;
  });

  const handleScale = async () => {
    if (targetReplicas === desiredReplicas) return;
    try {
      setScaling(true);
      const updatedManifest = {
        ...raw,
        spec: {
          ...spec,
          replicas: targetReplicas,
        },
      };
      if (k8s.demo) {
        useResourceStore.getState().updateItem(item.kind, item.uid, {
          ...item,
          raw: updatedManifest,
          replicas: targetReplicas,
        });
        toast.success(`Scaled ${item.name} to ${targetReplicas} replicas (demo memory)`);
      } else {
        if (!currentContext) {
          toast.error('No active cluster context');
          return;
        }
        await k8s.scaleWorkload(currentContext, item.kind, item.name, item.namespace!, targetReplicas, item.uid, item.raw?.metadata?.resourceVersion ?? '');
        toast.success(`Scale requested for ${item.name} (${targetReplicas} replicas)`);
      }
    } catch (err: any) {
      if (err?.code === 'cancelled') {
        toast.info('Scale cancelled');
      } else {
        toast.error('Failed to scale workload', String(err?.message || err));
      }
    } finally {
      setScaling(false);
    }
  };

  const [restarting, setRestarting] = useState(false);
  const handleRestart = async () => {
    if (!currentContext && !k8s.demo) {
      toast.error('No active cluster context');
      return;
    }
    const rawCopy = restartManifest(item);

    try {
      setRestarting(true);
      if (k8s.demo) {
        useResourceStore.getState().updateItem(item.kind, item.uid, { ...item, raw: rawCopy });
        toast.success(`Rollout restart triggered for ${item.kind}/${item.name} (demo)`);
      } else {
        await performResourceAction(currentContext!, item, { type: 'restart' });
        toast.success(`Rollout restart triggered for ${item.kind}/${item.name}`);
      }
    } catch (err: any) {
      if (err?.code === 'cancelled') toast.info('Restart cancelled');
      else toast.error('Failed to trigger rollout restart', String(err?.message || err));
    } finally {
      setRestarting(false);
    }
  };

  const strategy = spec.strategy ?? spec.updateStrategy;
  const matchLabels = spec.selector?.matchLabels;

  return (
    <div className="details-stack">
      {/* 1. "What's wrong" diagnostic banner */}
      <ProblemsBanner item={item} />

      {/* 2. Replicas & Scaling Card */}
      <section aria-label="Replicas and Pod status" className="details-section">
        <div className="details-section-heading bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users size="calc(13px * var(--ui-factor))" className="text-[var(--accent)]" />
            <span className="text-xs font-semibold text-[var(--text-primary)]">Replicas & Rollout Status</span>
          </div>
          <span className="text-[length:calc(10.5px*var(--ui-factor))] font-mono text-[var(--text-secondary)]">
            Ready: <strong className={readyReplicas === desiredReplicas ? 'text-emerald-400' : 'text-amber-400'}>{readyReplicas}</strong> / {desiredReplicas}
          </span>
        </div>

        <div className="p-2 space-y-3">
          {/* Quick Stats Grid */}
          <div className="details-stat-grid text-xs">
            <div className="p-2 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
              <span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] block">Desired</span>
              <span className="font-mono text-sm font-semibold text-[var(--text-primary)]">{desiredReplicas}</span>
            </div>
            <div className="p-2 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
              <span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] block">Ready</span>
              <span className="font-mono text-sm font-semibold text-emerald-400">{readyReplicas}</span>
            </div>
            <div className="p-2 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
              <span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] block">Available</span>
              <span className="font-mono text-sm font-semibold text-emerald-400">{availableReplicas}</span>
            </div>
            <div className="p-2 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
              <span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] block">Up-to-date</span>
              <span className="font-mono text-sm font-semibold text-cyan-400">{updatedReplicas}</span>
            </div>
          </div>

          {/* Interactive Scaler (Deployments & StatefulSets) */}
          {['Deployment', 'StatefulSet'].includes(item.kind) && (
            <div className="details-scaler pt-2 border-t border-[var(--border-subtle)]">
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--text-secondary)] font-medium">Replicas:</span>
                <div className="flex items-center border border-[var(--border-default)] rounded bg-[var(--bg-canvas)] overflow-hidden">
                  <button
                    type="button"
                    disabled={targetReplicas <= 0 || scaling}
                    onClick={() => setTargetReplicas((r) => Math.max(0, r - 1))}
                    className="p-1 px-1.5 hover:bg-[var(--bg-hover)] disabled:opacity-40 text-[var(--text-secondary)] transition-colors"
                    aria-label="Decrease replicas"
                  >
                    <Minus size="calc(12px * var(--ui-factor))" />
                  </button>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={targetReplicas}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, '');
                      setTargetReplicas(val === '' ? 0 : Math.min(1000, parseInt(val, 10)));
                    }}
                    className="w-10 text-center font-mono text-xs bg-transparent text-[var(--text-primary)] focus:outline-none py-1 select-all"
                    aria-label="Target replicas"
                  />
                  <button
                    type="button"
                    disabled={scaling}
                    onClick={() => setTargetReplicas((r) => Math.min(1000, r + 1))}
                    className="p-1 px-1.5 hover:bg-[var(--bg-hover)] disabled:opacity-40 text-[var(--text-secondary)] transition-colors"
                    aria-label="Increase replicas"
                  >
                    <Plus size="calc(12px * var(--ui-factor))" />
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-1.5 ml-auto">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={scaling || targetReplicas === desiredReplicas}
                  loading={scaling}
                  onClick={handleScale}
                >
                  Apply
                </Button>
                {['Deployment', 'StatefulSet', 'DaemonSet'].includes(item.kind) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={restarting}
                    onClick={handleRestart}
                    title="Trigger rollout restart"
                    className="gap-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  >
                    <RotateCw size="calc(11px * var(--ui-factor))" />
                    Restart
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Strategy & Selector Details (Lens parity) */}
          {(strategy || (matchLabels && Object.keys(matchLabels).length > 0)) && (
            <div className="pt-2 border-t border-[var(--border-subtle)] space-y-1.5 text-[length:calc(11px*var(--ui-factor))]">
              {strategy && (
                <div className="text-[var(--text-muted)] font-mono flex items-center gap-2">
                  <span>Strategy: <strong className="text-[var(--text-secondary)]">{strategy.type || 'RollingUpdate'}</strong></span>
                  {strategy.rollingUpdate && (
                    <span>
                      (maxSurge: {strategy.rollingUpdate.maxSurge ?? '25%'}, maxUnavailable: {strategy.rollingUpdate.maxUnavailable ?? '25%'})
                    </span>
                  )}
                </div>
              )}
              {matchLabels && Object.keys(matchLabels).length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[var(--text-muted)] text-[10.5px]">Selector:</span>
                  {Object.entries(matchLabels).map(([k, v]) => (
                    <span
                      key={k}
                      className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--text-secondary)]"
                    >
                      {k}={String(v)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* 3. Pod Template Containers */}
      <section aria-label="Pod Template Containers" className="details-section">
        <div className="details-section-heading bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers size="calc(13px * var(--ui-factor))" className="text-[var(--accent)]" />
            <span className="text-xs font-semibold text-[var(--text-primary)]">
              Pod Template Containers ({templateContainers.length})
            </span>
          </div>
        </div>
        <div className="p-2 space-y-2.5">
          {templateContainers.map((c: any) => (
            <ContainerCard
              key={c.name}
              container={{
                name: c.name,
                image: c.image ?? '',
                role: 'application',
                state: 'running',
                ready: true,
                restarts: 0,
                port: (c.ports ?? []).map((p: any) => `${p.containerPort}/${p.protocol ?? 'TCP'}`).join(', ') || '-',
              }}
              spec={c}
              status={{}}
              onLogs={() => onLogs(c.name)}
              onShell={() => onShell(c.name)}
            />
          ))}
        </div>
      </section>

      {/* 4. Revision History & Rollback (Deployments) */}
      {item.kind === 'Deployment' && (
        <RevisionHistoryBlock item={item} />
      )}

      {/* 5. Active Pods */}
      <section aria-label="Active Pods" className="details-section">
        <div className="details-section-heading bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity size="calc(13px * var(--ui-factor))" className="text-[var(--accent)]" />
            <span className="text-xs font-semibold text-[var(--text-primary)]">
              Child Pods ({pods.length})
            </span>
          </div>
        </div>
        <div className="p-2 max-h-56 overflow-y-auto divide-y divide-[var(--border-subtle)]">
          {pods.length === 0 ? (
            <div className="text-xs text-[var(--text-muted)] italic">No pods currently loaded for this workload.</div>
          ) : (
            pods.slice(0, 30).map((pod) => (
              <div key={pod.uid} className="flex items-center justify-between py-1.5 text-xs">
                <button
                  type="button"
                  onClick={() => onNavigate(pod)}
                  className="font-mono text-[var(--accent)] hover:underline truncate text-left"
                >
                  {pod.name}
                </button>
                <div className="flex items-center gap-2 text-[length:calc(10.5px*var(--ui-factor))] font-mono">
                  <span className="text-[var(--text-muted)]">{pod.node || 'unassigned'}</span>
                  <span className={pod.status === 'Running' ? 'text-emerald-400' : 'text-amber-400'}>
                    {pod.status ?? '—'}
                  </span>
                </div>
              </div>
            ))
          )}
          {pods.length > 30 && (
            <div className="pt-2 text-center text-xs text-[var(--text-muted)]">
              +{pods.length - 30} more pods
            </div>
          )}
        </div>
      </section>

      {/* 6. Conditions */}
      <ConditionsTable conditions={status.conditions} />

      {/* 7. Metadata */}
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
