import React, { useEffect, useState } from 'react';
import { Layers, Minus, Plus, RotateCw, ShieldAlert, Trash2, TriangleAlert } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input, Label } from '../ui/Input';
import { cx } from '../../core/utils/cx';
import type { ResourceItem } from '../../types/k8s';

/** Scale a workload (Deployment / StatefulSet / ReplicaSet / DaemonSet). */
export function ScaleDialog({
  item,
  onClose,
  onApply,
}: {
  item: ResourceItem | null;
  onClose: () => void;
  onApply: (replicas: number) => void;
}) {
  const current = Number(item?.ready?.split('/')[1] ?? item?.replicas ?? 1);
  const [replicas, setReplicas] = useState(current);

  useEffect(() => {
    if (item) setReplicas(Number(item.ready?.split('/')[1] ?? item.replicas ?? 1));
  }, [item?.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!item) return null;
  const value = Math.max(0, Math.min(1000, replicas || 0));

  return (
    <Modal
      open
      onClose={onClose}
      width={440}
      title={
        <span className="flex items-center gap-2">
          <Layers size="calc(14px * var(--ui-factor))" className="text-[var(--accent)]" />
          <span>Scale {item.kind}</span>
        </span>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { onApply(value); onClose(); }}>
            Scale to {value}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-[calc(6px*var(--ui-factor))] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 flex items-center justify-between text-[length:calc(12px*var(--ui-factor))]">
          <div className="flex items-center gap-2 min-w-0">
            <span className="px-1.5 py-0.5 rounded font-mono font-medium text-[var(--text-primary)] bg-[var(--bg-secondary)] border border-[var(--border-subtle)] truncate">
              {item.name}
            </span>
            <span className="text-[var(--text-muted)] text-[length:calc(11px*var(--ui-factor))] font-mono truncate">
              {item.namespace || 'default'}
            </span>
          </div>
          <span className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] shrink-0 font-medium">
            Current: {current}
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <Label>Target Replicas</Label>
          <div className="flex items-center gap-2">
            <Button onClick={() => setReplicas(Math.max(0, replicas - 1))} className="!w-9 !px-0 justify-center">
              <Minus size="calc(13px * var(--ui-factor))" />
            </Button>
            <Input
              value={String(replicas)}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/[^\d]/g, ''));
                setReplicas(Number.isNaN(n) ? 0 : n);
              }}
              className="flex-1 text-center font-mono font-medium"
            />
            <Button onClick={() => setReplicas(Math.min(1000, replicas + 1))} className="!w-9 !px-0 justify-center">
              <Plus size="calc(13px * var(--ui-factor))" />
            </Button>
          </div>
          <div className="flex gap-1.5 mt-1">
            {[0, 1, 2, 3, 5, 10].map((n) => (
              <Button
                key={n}
                size="sm"
                variant={replicas === n ? 'secondary' : 'ghost'}
                onClick={() => setReplicas(n)}
                className={cx('flex-1 !px-0 justify-center font-mono', replicas === n && '!bg-[var(--accent-subtle)] !text-[var(--accent)] !border-[var(--accent)]/40 font-semibold')}
              >
                {n}
              </Button>
            ))}
          </div>
        </div>

        {value === 0 && (
          <div className="rounded-[calc(6px*var(--ui-factor))] border border-[var(--status-warn)]/30 bg-[var(--status-warn)]/10 p-2.5 flex items-start gap-2.5 text-[length:calc(11px*var(--ui-factor))] text-[var(--status-warn)] leading-relaxed">
            <TriangleAlert size="calc(14px * var(--ui-factor))" className="shrink-0 mt-0.5" />
            <span>Scaling to 0 will remove all running pods from service and terminate active workloads.</span>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Comprehensive delete confirmation dialog with metadata, warnings and cascading deletion notice. */
export function DeleteResourceDialog({
  item,
  onClose,
  onConfirm,
}: {
  item: ResourceItem | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!item) return null;

  const rawMeta = item.raw?.metadata;
  const labels = rawMeta?.labels ? Object.entries(rawMeta.labels) : [];
  const finalizers: string[] = rawMeta?.finalizers ?? [];
  const ownerRefs: any[] = rawMeta?.ownerReferences ?? [];
  const isCrd = item.kind === 'CustomResourceDefinition';
  const isNamespace = item.kind === 'Namespace';
  const isWorkload = ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob'].includes(item.kind);

  return (
    <Modal
      open
      onClose={onClose}
      width={540}
      title={
        <span className="flex items-center gap-2">
          <Trash2 size="calc(15px * var(--ui-factor))" className="text-[var(--status-error)]" />
          <span>Delete {item.kind.toLowerCase()}</span>
        </span>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            Delete
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5 text-[length:calc(12px*var(--ui-factor))]">
        {/* Resource Identity Block */}
        <div className="rounded-[calc(6px*var(--ui-factor))] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3.5 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="px-2 py-0.5 rounded text-[length:calc(11px*var(--ui-factor))] font-semibold bg-[var(--status-error)]/10 text-[var(--status-error)] border border-[var(--status-error)]/20 uppercase tracking-wide shrink-0">
                {item.kind}
              </span>
              <span className="font-mono font-medium text-[var(--text-primary)] truncate" title={item.name}>
                {item.name}
              </span>
            </div>
            {item.namespace && (
              <span className="px-1.5 py-0.5 rounded font-mono text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] bg-[var(--bg-secondary)] border border-[var(--border-subtle)] shrink-0">
                ns: {item.namespace}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)] font-mono pt-1.5 border-t border-[var(--border-subtle)]/50">
            {item.apiVersion && <span>API: {item.apiVersion}</span>}
            {rawMeta?.resourceVersion && <span>RV: {rawMeta.resourceVersion}</span>}
            {rawMeta?.creationTimestamp && <span>Created: {new Date(rawMeta.creationTimestamp).toLocaleString()}</span>}
          </div>
        </div>

        {/* Cascading Deletion Warnings */}
        {isCrd && (
          <div className="rounded-[calc(6px*var(--ui-factor))] border border-[var(--status-error)]/30 bg-[var(--status-error)]/10 p-3 flex items-start gap-2.5 text-[var(--status-error)]">
            <TriangleAlert size="calc(16px * var(--ui-factor))" className="shrink-0 mt-0.5" />
            <div className="flex flex-col gap-0.5 leading-relaxed">
              <span className="font-semibold text-[length:calc(12px*var(--ui-factor))]">Cascading CRD Deletion</span>
              <span className="text-[length:calc(11px*var(--ui-factor))] opacity-90">
                Deleting this CustomResourceDefinition will permanently delete <strong>all custom resources</strong> defined by it across all namespaces in the cluster.
              </span>
            </div>
          </div>
        )}

        {isNamespace && (
          <div className="rounded-[calc(6px*var(--ui-factor))] border border-[var(--status-error)]/30 bg-[var(--status-error)]/10 p-3 flex items-start gap-2.5 text-[var(--status-error)]">
            <TriangleAlert size="calc(16px * var(--ui-factor))" className="shrink-0 mt-0.5" />
            <div className="flex flex-col gap-0.5 leading-relaxed">
              <span className="font-semibold text-[length:calc(12px*var(--ui-factor))]">Cascading Namespace Deletion</span>
              <span className="text-[length:calc(11px*var(--ui-factor))] opacity-90">
                Deleting this Namespace will permanently delete <strong>all workloads, pods, services, secrets, and configurations</strong> contained inside it.
              </span>
            </div>
          </div>
        )}

        {isWorkload && (
          <div className="rounded-[calc(6px*var(--ui-factor))] border border-[var(--status-warn)]/30 bg-[var(--status-warn)]/10 p-3 flex items-start gap-2.5 text-[var(--status-warn)]">
            <ShieldAlert size="calc(16px * var(--ui-factor))" className="shrink-0 mt-0.5" />
            <div className="flex flex-col gap-0.5 leading-relaxed">
              <span className="font-semibold text-[length:calc(12px*var(--ui-factor))]">Background Garbage Collection</span>
              <span className="text-[length:calc(11px*var(--ui-factor))] opacity-90">
                Kubernetes controllers and background garbage collection will terminate and delete all dependent Pods and ReplicaSets managed by this {item.kind}.
              </span>
            </div>
          </div>
        )}

        {finalizers.length > 0 && (
          <div className="rounded-[calc(6px*var(--ui-factor))] border border-[var(--status-warn)]/30 bg-[var(--status-warn)]/10 p-3 flex items-start gap-2.5 text-[var(--status-warn)]">
            <ShieldAlert size="calc(16px * var(--ui-factor))" className="shrink-0 mt-0.5" />
            <div className="flex flex-col gap-1 leading-relaxed">
              <span className="font-semibold text-[length:calc(12px*var(--ui-factor))]">Active Finalizers ({finalizers.length})</span>
              <span className="text-[length:calc(11px*var(--ui-factor))] opacity-90">
                This resource will stay in <code className="px-1 py-0.5 rounded bg-[var(--bg-base)] border border-[var(--border-subtle)] font-mono text-[var(--text-primary)]">Terminating</code> state until its finalizers are removed by their controllers:
              </span>
              <div className="flex flex-wrap gap-1 mt-0.5 font-mono text-[length:calc(10px*var(--ui-factor))]">
                {finalizers.map((f) => (
                  <span key={f} className="px-1.5 py-0.5 rounded bg-[var(--bg-base)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {ownerRefs.length > 0 && (
          <div className="rounded-[calc(6px*var(--ui-factor))] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2.5 flex flex-col gap-1 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text-primary)]">Controlled by:</span>
            <div className="flex flex-wrap gap-1 font-mono">
              {ownerRefs.map((o) => (
                <span key={o.uid || o.name} className="px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
                  {o.kind}/{o.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {labels.length > 0 && (
          <div className="flex flex-col gap-1 pt-0.5">
            <span className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)] font-medium">Labels ({labels.length})</span>
            <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
              {labels.slice(0, 8).map(([k, v]) => (
                <span key={k} className="px-1.5 py-0.5 rounded font-mono text-[length:calc(10px*var(--ui-factor))] bg-[var(--bg-surface)] text-[var(--text-secondary)] border border-[var(--border-subtle)] truncate max-w-[240px]">
                  {k}={String(v)}
                </span>
              ))}
              {labels.length > 8 && (
                <span className="px-1.5 py-0.5 text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)]">
                  +{labels.length - 8} more
                </span>
              )}
            </div>
          </div>
        )}

        <p className="text-[var(--text-secondary)] leading-relaxed pt-1 border-t border-[var(--border-subtle)]/50">
          Are you sure you want to delete <strong className="font-mono text-[var(--text-primary)]">{item.kind}/{item.name}</strong>
          {item.namespace ? <> from namespace <strong className="font-mono text-[var(--text-primary)]">{item.namespace}</strong></> : null}?
          This action cannot be undone.
        </p>
      </div>
    </Modal>
  );
}

/** Destructive confirmation (Delete / Drain / Evict). */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  variant,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  variant?: 'danger' | 'primary' | 'warning';
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  const isDanger = variant === 'danger' || (!variant && (
    confirmLabel.toLowerCase().includes('delete') ||
    confirmLabel.toLowerCase().includes('drain') ||
    confirmLabel.toLowerCase().includes('evict')
  ));

  return (
    <Modal
      open
      onClose={onClose}
      width={440}
      title={
        <span className="flex items-center gap-2">
          {isDanger ? (
            <Trash2 size="calc(14px * var(--ui-factor))" className="text-[var(--status-error)]" />
          ) : (
            <ShieldAlert size="calc(14px * var(--ui-factor))" className="text-[var(--status-warn)]" />
          )}
          <span>{title}</span>
        </span>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={isDanger ? 'danger' : 'primary'}
            onClick={() => { onConfirm(); onClose(); }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-[calc(6px*var(--ui-factor))] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3.5 flex items-start gap-3">
          <div className={cx(
            'p-2 rounded-[calc(6px*var(--ui-factor))] shrink-0 border mt-0.5',
            isDanger
              ? 'bg-[var(--status-error)]/10 text-[var(--status-error)] border-[var(--status-error)]/20'
              : 'bg-[var(--status-warn)]/10 text-[var(--status-warn)] border-[var(--status-warn)]/20'
          )}>
            {isDanger ? (
              <TriangleAlert size="calc(16px * var(--ui-factor))" />
            ) : (
              <ShieldAlert size="calc(16px * var(--ui-factor))" />
            )}
          </div>
          <div className="flex-1 text-[length:calc(12px*var(--ui-factor))] text-[var(--text-secondary)] leading-relaxed">
            {message}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Rollout restart confirmation. */
export function RestartDialog({ item, onClose, onConfirm }: { item: ResourceItem | null; onClose: () => void; onConfirm: () => void }) {
  if (!item) return null;
  return (
    <Modal
      open
      onClose={onClose}
      width={440}
      title={
        <span className="flex items-center gap-2">
          <RotateCw size="calc(14px * var(--ui-factor))" className="text-[var(--accent)]" />
          <span>Restart Rollout</span>
        </span>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { onConfirm(); onClose(); }}>
            Restart Rollout
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-[calc(6px*var(--ui-factor))] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3.5 flex items-start gap-3">
          <div className="p-2 rounded-[calc(6px*var(--ui-factor))] bg-[var(--accent)]/10 text-[var(--accent)] shrink-0 border border-[var(--accent)]/20 mt-0.5">
            <RotateCw size="calc(16px * var(--ui-factor))" />
          </div>
          <div className="flex-1 text-[length:calc(12px*var(--ui-factor))] text-[var(--text-secondary)] leading-relaxed">
            A rolling restart of{' '}
            <span className="px-1.5 py-0.5 rounded font-mono font-medium text-[var(--text-primary)] bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
              {item.kind}/{item.name}
            </span>{' '}
            will trigger a rollout update of all managed pods.
          </div>
        </div>
      </div>
    </Modal>
  );
}
