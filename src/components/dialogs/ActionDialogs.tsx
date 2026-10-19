import React, { useEffect, useState } from 'react';
import { Minus, Plus, RotateCw, TriangleAlert } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input, Label } from '../ui/Input';
import type { ResourceItem } from '../../types/k8s';

/** Scale a workload (Deployment / StatefulSet / DaemonSet mock). */
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
  const value = Math.max(0, Math.min(64, replicas || 0));

  return (
    <Modal
      open
      onClose={onClose}
      width={400}
      title="Scale workload"
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
        <div className="rounded-[6px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2 text-[12px] font-mono">
          {item.kind}/{item.name}
          <span className="text-[var(--text-muted)]"> · {item.namespace}</span>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Replicas</Label>
          <div className="flex items-center gap-2">
            <Button onClick={() => setReplicas(Math.max(0, replicas - 1))} className="!w-8 !px-0 justify-center">
              <Minus size={13} />
            </Button>
            <Input
              value={String(replicas)}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/[^\d]/g, ''));
                setReplicas(Number.isNaN(n) ? 0 : n);
              }}
              className="flex-1"
            />
            <Button onClick={() => setReplicas(Math.min(64, replicas + 1))} className="!w-8 !px-0 justify-center">
              <Plus size={13} />
            </Button>
          </div>
          <div className="flex gap-1 mt-1">
            {[0, 1, 2, 3, 5, 10].map((n) => (
              <Button key={n} size="sm" variant="ghost" onClick={() => setReplicas(n)}>
                {n}
              </Button>
            ))}
          </div>
        </div>

        {value === 0 && (
          <div className="flex items-center gap-2 text-[11px] text-[var(--status-warn)]">
            <TriangleAlert size={13} />
            Scaling to 0 will remove all pods from service.
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Destructive confirmation. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <Modal
      open
      onClose={onClose}
      width={400}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => { onConfirm(); onClose(); }}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-3 text-[12px] text-[var(--text-secondary)] leading-relaxed">
        <TriangleAlert size={16} className="text-[var(--status-warn)] shrink-0 mt-0.5" />
        <div>{message}</div>
      </div>
    </Modal>
  );
}

/** Mock "restart rollout" notice. */
export function RestartDialog({ item, onClose, onConfirm }: { item: ResourceItem | null; onClose: () => void; onConfirm: () => void }) {
  if (!item) return null;
  return (
    <Modal
      open
      onClose={onClose}
      width={400}
      title={
        <span className="flex items-center gap-2">
          <RotateCw size={14} className="text-[var(--accent)]" />
          Restart rollout
        </span>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { onConfirm(); onClose(); }}>
            Restart
          </Button>
        </>
      }
    >
      <p className="text-[12px] text-[var(--text-secondary)] leading-relaxed">
        A rolling restart of <span className="font-mono text-[var(--text-primary)]">{item.kind}/{item.name}</span> will replace
        all pods one by one (demo: the workload status becomes Running).
      </p>
    </Modal>
  );
}
